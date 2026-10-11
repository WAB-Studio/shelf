"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { confirmImport } from "@/app/actions/import";
import { draftRefusals, phaseCuts, phaseDrops, strayEstimates, withoutStrayEstimates, type ImportDraft } from "@/lib/import/draft";
import { clearDraft, readDraft, saveReview } from "@/lib/import/draft-store";
import { repeatedGoals } from "@/lib/import/repeated";
import { dayBefore } from "@/lib/day/weeks";
import { formatQuantity, isTimeUnit, splitMinutes } from "@/lib/units/time";
import { setMonthBudgetSchema } from "@/lib/validation/budget";
import { createOneOffSchema } from "@/lib/validation/one-off";
import { setRhythmSchema } from "@/lib/validation/rhythm";
import { weekdaysSentence } from "@/lib/day/row-phrases";
import { shortMonth } from "@/lib/dates/short-month";
import { civilDateToDate } from "@/lib/zone";
import { useTimeWords } from "@/components/ui/figure";
import {
  ActionBar,
  Button,
  CheckRow,
  Field,
  Figure,
  Flex,
  ListDetail,
  Notice,
  Page,
  Panel,
  PanelGrid,
  ScreenHeader,
  Section,
  Sheet,
  SheetActions,
  Text,
  TextArea,
  TextLink,
} from "@/components/ui";
import { messageKey } from "@/i18n/translator";

type Goal = ImportDraft["goals"][number];
type Commitment = Goal["commitments"][number];

const WHOLE = /^\d+$/;
const monthAmount = setMonthBudgetSchema.shape.amount;
const rhythmAmount = setRhythmSchema.shape.amount;
const taskEstimate = createOneOffSchema.shape.estimate.nonoptional();

// What the person has unmarked, by item path ("goals.0.months.1"). A parent's
// path carries its descendants: unmarking one writes all of them.
type Unmarked = ReadonlySet<string>;

const goalPath = (g: number) => `goals.${g}`;

// The paths under a goal or a task, itself included.
function underneath(draft: ImportDraft, path: string): string[] {
  const match = /^goals\.(\d+)(?:\.tasks\.(\d+))?$/.exec(path);
  if (!match) return [path];
  const goal = draft.goals[Number(match[1])];
  if (match[2] !== undefined) {
    const t = Number(match[2]);
    return [path, ...goal.tasks[t].children.map((_, c) => `${path}.children.${c}`)];
  }
  return [
    path,
    ...goal.phases.map((_, p) => `${path}.phases.${p}`),
    ...goal.months.map((_, m) => `${path}.months.${m}`),
    ...goal.commitments.map((_, c) => `${path}.commitments.${c}`),
    ...goal.tasks.flatMap((task, t) => underneath(draft, `${path}.tasks.${t}`)),
  ];
}

// What `confirmImport` is sent: the marked items alone, and none the draft's
// own refusals name. A parent's unmarked children go with it.
export function markedDraft(draft: ImportDraft, unmarked: Unmarked, refused: ReadonlySet<string>): ImportDraft {
  const kept = (path: string) => !unmarked.has(path) && !refused.has(path);
  const goals = draft.goals.flatMap((goal, g) => {
    const at = goalPath(g);
    if (!kept(at) || refused.has(`${at}.horizon`)) return [];
    return [
      {
        ...goal,
        rhythm: kept(`${at}.rhythm`) ? goal.rhythm : null,
        phases: goal.phases.filter((_, p) => kept(`${at}.phases.${p}`)),
        months: goal.months.filter((_, m) => kept(`${at}.months.${m}`)),
        commitments: goal.commitments.filter((_, c) => kept(`${at}.commitments.${c}`)),
        tasks: goal.tasks.flatMap((task, t) => {
          const taskAt = `${at}.tasks.${t}`;
          if (!kept(taskAt)) return [];
          return [{ ...task, children: task.children.filter((_, c) => kept(`${taskAt}.children.${c}`)) }];
        }),
      },
    ];
  });
  return { goals };
}

// Writes an amount at an item's path in a copy of the draft.
function withAmount(draft: ImportDraft, path: string, amount: number): ImportDraft {
  const next = structuredClone(draft);
  const parts = path.split(".");
  const goal = next.goals[Number(parts[1])];
  if (parts[2] === "rhythm") goal.rhythm = amount;
  else if (parts[2] === "months") goal.months[Number(parts[3])].amount = amount;
  else if (parts[4] === "children") goal.tasks[Number(parts[3])].children[Number(parts[5])].estimate = amount;
  else goal.tasks[Number(parts[3])].estimate = amount;
  return next;
}

type Editing = { path: string; title: string; unit: string; amount: number; schema: "month" | "task" | "rhythm" };

/**
 * `/metas/importar/revisar` (RP-37): the draft grouped by goal, every item
 * marked in by default. An unmarked item is never sent; what the draft holds
 * that cannot be written is listed on top, unmarked and not markable. A month
 * amount and an estimate are write-once after the import (RP-30), so the
 * amount buttons are the person's one cheap chance to change one.
 */
export function ReviewScreen({ today, openGoalNames }: { today: string; openGoalNames: string[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const words = useTimeWords();
  const [stored, setStored] = useState<ReturnType<typeof readDraft>>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [unmarked, setUnmarked] = useState<Unmarked>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The names the draft is first measured against; a server refresh never re-reads it.
  const [startNames] = useState(openGoalNames);
  const confirmed = useRef(false);

  // The tab's storage is only there once mounted; the server paints no draft.
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!live || confirmed.current) return;
      const read = readDraft();
      if (!read) {
        router.replace("/metas/importar");
        return;
      }
      setStored(read);
      setDraft(read.draft);
      // A fresh draft starts with the goals an open goal already names unmarked.
      if (read.unmarked !== null) setUnmarked(new Set(read.unmarked));
      else {
        const clean = withoutStrayEstimates(read.draft);
        setUnmarked(new Set(repeatedGoals(clean, startNames).flatMap((g) => underneath(clean, goalPath(g)))));
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [router, startNames]);

  // The goals with no measure keep their tasks, without the time they cannot hold.
  const work = useMemo(() => (draft ? withoutStrayEstimates(draft) : null), [draft]);
  const strays = useMemo(() => new Map(draft ? strayEstimates(draft).map((stray) => [stray.path, stray.key] as const) : []), [draft]);
  const repeated = useMemo(() => new Set(work ? repeatedGoals(work, openGoalNames) : []), [work, openGoalNames]);
  const refusals = useMemo(() => (work ? draftRefusals(work, today) : []), [work, today]);
  const refused = useMemo(() => new Set(refusals.map((refusal) => refusal.path)), [refusals]);
  // A goal refused whole says so once; what lies under it is not listed.
  const listed = useMemo(
    () =>
      refusals.filter((refusal) => {
        const g = refusal.path.split(".")[1];
        return refusal.path.endsWith(".horizon") || !refused.has(`goals.${g}.horizon`);
      }),
    [refusals, refused],
  );
  const sent = useMemo(() => (work ? markedDraft(work, unmarked, refused) : null), [work, unmarked, refused]);

  if (!loaded || !stored || !draft || !work || !sent) return <Page width="full" />;

  const monthWord = (month: string, long = false) =>
    format.dateTime(civilDateToDate(`${month}-01`), long ? { month: "long", year: "numeric", timeZone: "UTC" } : { month: "long", timeZone: "UTC" });
  const dayLabel = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const phaseSpan = (startsOn: string, endsOn: string) => {
    if (startsOn.slice(0, 7) === endsOn.slice(0, 7)) return shortMonth(startsOn);
    const crossesYear = startsOn.slice(0, 4) !== endsOn.slice(0, 4);
    const year = (date: string) => (crossesYear ? ` ${date.slice(0, 4)}` : "");
    return `${shortMonth(startsOn)}${year(startsOn)}–${shortMonth(endsOn)}${year(endsOn)}`;
  };
  // The board's form for a day inside the year: no year.
  const dayAndMonth = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "long", timeZone: "UTC" });
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const figure = (value: number | null, unit: string | null): ReactNode =>
    unit === null || value === null ? null : <Figure value={value} unit={unit} variant="meta" />;

  function cadenceText(commitment: Commitment): string {
    switch (commitment.cadenceKind) {
      case "daily":
        return t("goal.cadence.daily");
      case "weekdays": {
        return weekdaysSentence((key, values) => t(key, values), commitment.cadenceWeekdays ?? [], t.raw("goal.cadence.weekdayFull") as string[]);
      }
      case "times_per_week":
        return t("goal.cadence.timesPerWeek", { count: commitment.cadenceN ?? 0 });
      case "every_n_days":
        return commitment.cadenceN === 1 ? t("goal.cadence.daily") : t("goal.cadence.everyNDays", { n: commitment.cadenceN ?? 0 });
      case "times_per_month":
        return t("goal.cadence.timesPerMonth", { count: commitment.cadenceN ?? 0 });
    }
  }

  function toggle(path: string, on: boolean) {
    const next = new Set(unmarked);
    for (const entry of underneath(work!, path)) {
      if (on) next.delete(entry);
      else next.add(entry);
    }
    setUnmarked(next);
    saveReview(draft!, [...next]);
  }

  const goalsKept = sent.goals.length;
  const cuts = phaseCuts(work, today);
  const drops = new Set(phaseDrops(work, today).map((drop) => drop.path));
  const droppedAims = phaseDrops(work, today);

  // What the bar says stays out: the one item by name, several by count.
  function outLine(): ReactNode {
    if (listed.length === 0) return null;
    if (listed.length > 1) {
      return t.rich("import.review.out.many", {
        count: listed.length,
        link: (chunks) => <TextLink href="#blocked">{chunks}</TextLink>,
      });
    }
    const [, g, group, index] = listed[0].path.split(".");
    const goal = work!.goals[Number(g)];
    let name = goal.name;
    let subTasks = 0;
    if (group === "phases") name = goal.phases[Number(index)].aim;
    else if (group === "months") name = monthWord(goal.months[Number(index)].month, true);
    else if (group === "commitments") name = goal.commitments[Number(index)].name;
    else if (group === "tasks") {
      const task = goal.tasks[Number(index)];
      name = task.name;
      subTasks = task.children.length;
    }
    return t("import.review.out.one", { name, subTasks });
  }
  const out = outLine();

  async function confirm() {
    if (pending || goalsKept === 0) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await confirmImport(sent);
      if (result.ok) {
        confirmed.current = true;
        clearDraft();
        router.push("/metas");
        return;
      }
      setFailure(t(result.error.includes(".errors.") ? result.error : "import.review.failed"));
    } catch {
      setFailure(t("import.review.failed"));
    }
    setPending(false);
  }

  function reasonOf(key: string, values: Record<string, string> = {}): string {
    switch (key) {
      case "import.errors.monthBeforeStart":
        return t("import.review.blocked.monthBeforeStart", { first: monthWord(values.first) });
      case "import.errors.monthAfterEnd":
        return t("import.review.blocked.monthAfterEnd", {
          last: dayLabel(values.last),
        });
      case "import.errors.amountNoMeasure":
        return t("import.review.blocked.amountNoMeasure");
      case "import.errors.quantityNoMeasure":
        return t("import.review.blocked.quantityNoMeasure");
      default:
        return t(messageKey(key));
    }
  }

  // The refusals list: what each item is called, and where it came from.
  function blockedRow(path: string, key: string, values?: Record<string, string>) {
    const [, g, group, index, , child] = path.split(".");
    const goal = work!.goals[Number(g)];
    let title: ReactNode = goal.name;
    let groupWord = t("import.review.horizon");
    if (group === "phases") {
      const phase = goal.phases[Number(index)];
      title = phase.aim;
      groupWord = t("import.review.groups.phases");
    } else if (group === "months") {
      const entry = goal.months[Number(index)];
      title = (
        <>
          {monthWord(entry.month, true)} · {figure(entry.amount, goal.measure?.unit ?? "")}
        </>
      );
      groupWord = t("import.review.groups.months");
    } else if (group === "commitments") {
      const commitment = goal.commitments[Number(index)];
      title = `${commitment.name} · ${cadenceText(commitment)}`;
      groupWord = t("import.review.groups.commitments");
    } else if (group === "tasks") {
      const task = goal.tasks[Number(index)];
      const item = child === undefined ? task : task.children[Number(child)];
      title = (
        <>
          {item.name}
          {item.estimate !== null ? <> · {figure(item.estimate, goal.measure?.unit ?? "")}</> : null}
        </>
      );
      groupWord = t("import.review.groups.tasks");
    }
    return (
      <CheckRow
        key={path}
        checked={false}
        disabled
        name={title}
        meta={t("import.review.blocked.from", { goal: goal.name, group: groupWord })}
        reason={reasonOf(key, values)}
      />
    );
  }

  function amountProps(path: string, name: string, unit: string, amount: number, schema: Editing["schema"]) {
    return {
      amount: figure(amount, unit),
      amountLabel: t("import.review.amountOf", { name, amount: formatQuantity(amount, unit, words) }),
      onAmount: () => setEditing({ path, title: name, unit, amount, schema }),
    };
  }

  const eyebrow = stored.via === "template" ? t("import.review.eyebrowTemplate") : t("import.review.eyebrow");

  // What the review was read from sits beside it from 1024; a file leaves no text to show.
  const source = (
    <Flex direction="column" gap="5">
      {stored.source !== null ? (
        <TextArea label={t("import.review.sourceLabel")} readOnly rows={16} value={stored.source} />
      ) : (
        <Section label={t("import.review.sourceLabel")}>
          <Text as="p" variant="sentence" tone="muted">
            {stored.sourceName
              ? t("import.review.sourceFile", { name: stored.sourceName })
              : t("import.review.sourceFileAnon")}
          </Text>
        </Section>
      )}
      <Button asChild block variant="outline">
        <Link href="/metas/importar">{t("import.review.change")}</Link>
      </Button>
    </Flex>
  );

  const createButton = (
    <Button block onClick={confirm} disabled={pending || goalsKept === 0} aria-busy={pending || undefined}>
      {pending ? t("import.review.creating") : t("import.review.create", { count: goalsKept })}
    </Button>
  );

  const review = (
    <Flex direction="column" gap="6">
      <Text as="p" variant="sentence" tone="muted">
        {t("import.review.hint")}
      </Text>

      {refusals.length > 0 ? (
        <Section>
          <Text asChild variant="heading">
            <h2 id="blocked">{t("import.review.blocked.title")}</h2>
          </Text>
          <Text as="p" variant="sentence" tone="muted">
            {t("import.review.blocked.hint")}
          </Text>
          <div>
          {listed
            .map((refusal) => blockedRow(refusal.path, refusal.key, refusal.values))}
          </div>
        </Section>
      ) : null}

      <PanelGrid>
      {work.goals.map((goal, g) => {
        const at = goalPath(g);
        if (refused.has(`${at}.horizon`)) return null;
        const unit = goal.measure?.unit ?? null;
        const ok = (path: string) => !refused.has(path);
        const on = (path: string) => !unmarked.has(path);
        const goalOn = on(at);
        const phases = goal.phases
          .map((phase, p) => ({ phase, path: `${at}.phases.${p}` }))
          .filter((entry) => ok(entry.path) && !drops.has(entry.path));
        const lastDay = dayBefore(goal.horizon);
        const cutNotes = cuts
          .filter((cut) => cut.path.startsWith(`${at}.phases.`) && ok(cut.path))
          .map((cut) => t.rich("import.review.cutPhase", { aim: cut.aim, date: dayAndMonth(cut.from), ...fig }));
        const dropNotes = droppedAims
          .filter((drop) => drop.path.startsWith(`${at}.phases.`) && ok(drop.path))
          .map((drop) => t("import.review.droppedPhase", { aim: drop.aim }));
        const notes = [...cutNotes, ...dropNotes];
        const months = goal.months.map((entry, m) => ({ entry, path: `${at}.months.${m}` })).filter((item) => ok(item.path));
        const commitments = goal.commitments.map((commitment, c) => ({ commitment, path: `${at}.commitments.${c}` })).filter((item) => ok(item.path));
        const planned = goalOn && on(`${at}.rhythm`) && goal.rhythm !== null && unit !== null && isTimeUnit(unit);
        const tasks = goal.tasks.map((task, i) => ({ task, path: `${at}.tasks.${i}` })).filter((item) => ok(item.path));
        return (
          <Panel key={at} stacked label={goal.name}>
            <Flex direction="column" gap="6">
              <Section as="div">
                <Text asChild variant="heading">
                  <h2>{goal.name}</h2>
                </Text>
                {repeated.has(g) ? (
                  <div role="note">
                    <Panel as="div" bordered>
                      <Text as="p" variant="body">
                        {t("import.review.repeated")}
                      </Text>
                    </Panel>
                  </div>
                ) : null}
                <Text as="p" variant="sentence" tone="muted">
                  {t.rich("import.review.goalSpan", {
                    from: dayAndMonth(today),
                    to: dayLabel(lastDay),
                    ...fig,
                  })}
                </Text>
                <CheckRow
                  checked={goalOn}
                  onCheckedChange={(value) => toggle(at, value)}
                  name={t("import.review.horizonUntil", { date: dayLabel(dayBefore(goal.horizon)) })}
                  meta={t("import.review.horizon")}
                />
                {goal.measure ? (
                  <CheckRow
                    checked={goalOn}
                    onCheckedChange={(value) => toggle(at, value)}
                    name={goal.measure.name}
                    meta={t("import.review.measure")}
                    trailing={isTimeUnit(goal.measure.unit) ? t("import.review.measureTime") : (words.unit?.(goal.measure.unit, 2) ?? goal.measure.unit)}
                  />
                ) : null}
                {goal.measure && goal.rhythm !== null && isTimeUnit(goal.measure.unit) ? (
                  <CheckRow
                    checked={goalOn && on(`${at}.rhythm`)}
                    disabled={!goalOn}
                    onCheckedChange={(value) => toggle(`${at}.rhythm`, value)}
                    name={t("import.review.rhythmName")}
                    boxLabel={t("import.review.rhythmOf", { amount: formatQuantity(goal.rhythm, goal.measure.unit, words) })}
                    meta={t("import.review.rhythmMeta")}
                    amount={figure(goal.rhythm, goal.measure.unit)}
                    amountLabel={t("import.review.rhythmAmountOf", { amount: formatQuantity(goal.rhythm, goal.measure.unit, words) })}
                    onAmount={() =>
                      setEditing({
                        path: `${at}.rhythm`,
                        title: t("import.review.edit.rhythmEyebrow", { goal: goal.name }),
                        unit: goal.measure!.unit,
                        amount: goal.rhythm!,
                        schema: "rhythm",
                      })
                    }
                  />
                ) : null}
              </Section>
              {phases.length > 0 ? (
                <Section label={t("import.review.groups.phases")} as="div">
                  <div>
                    {phases.map(({ phase, path }) => (
                      <CheckRow
                        key={path}
                        checked={goalOn && on(path)}
                        disabled={!goalOn}
                        onCheckedChange={(value) => toggle(path, value)}
                        name={phase.aim}
                        trailing={phaseSpan(phase.startsOn, phase.endsOn)}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}

              {notes.length > 0 ? (
                <Panel as="div" bordered>
                  <Text as="p" variant="body">
                    {notes.map((note, n) => (
                      <Fragment key={n}>
                        {n > 0 ? " " : null}
                        {note}
                      </Fragment>
                    ))}
                  </Text>
                </Panel>
              ) : null}

              {months.length > 0 ? (
                <Section label={t("import.review.groups.months")} as="div">
                  <div>
                    {months.map(({ entry, path }) => (
                      <CheckRow
                        key={path}
                        checked={goalOn && on(path)}
                        disabled={!goalOn}
                        onCheckedChange={(value) => toggle(path, value)}
                        name={monthWord(entry.month)}
                        meta={planned ? t("import.review.inLieuOfRhythm") : undefined}
                        {...amountProps(path, monthWord(entry.month), unit ?? "", entry.amount, "month")}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}

              {commitments.length > 0 ? (
                <Section label={t("import.review.groups.commitments")} as="div">
                  <div>
                    {commitments.map(({ commitment, path }) => (
                      <CheckRow
                        key={path}
                        checked={goalOn && on(path)}
                        disabled={!goalOn}
                        onCheckedChange={(value) => toggle(path, value)}
                        name={commitment.name}
                        meta={commitment.satisfaction === "tap" ? `${cadenceText(commitment)} · ${t("goal.satisfaction.tap")}` : cadenceText(commitment)}
                        trailing={commitment.targetQuantity !== null ? figure(commitment.targetQuantity, commitment.unit) : undefined}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}

              {tasks.length > 0 ? (
                <Section label={t("import.review.groups.tasks")} as="div">
                  <div>
                    {tasks.map(({ task, path }) => {
                      const taskOn = goalOn && on(path);
                      const children = task.children
                        .map((child, c) => ({ child, path: `${path}.children.${c}` }))
                        .filter((item) => ok(item.path));
                      const sum = children.reduce((total, item) => total + (on(item.path) && taskOn ? (item.child.estimate ?? 0) : 0), 0);
                      return (
                        <Fragment key={path}>
                          <CheckRow
                            checked={taskOn}
                            disabled={!goalOn}
                            onCheckedChange={(value) => toggle(path, value)}
                            name={task.name}
                            note={task.note}
                            meta={
                              planned
                                ? t("import.review.toPlan")
                                : task.children.length > 0
                                ? t("import.review.sumOfMarked", { month: monthWord(task.month) })
                                : strays.has(path)
                                  ? `${monthWord(task.month)} · ${t(messageKey(strays.get(path)!))}`
                                  : monthWord(task.month)
                            }
                            metaMore={
                              planned && task.children.length > 0
                                ? t("import.review.sumAlone")
                                : undefined
                            }
                            {...(task.children.length === 0 && task.estimate !== null
                              ? amountProps(path, task.name, unit ?? "", task.estimate, "task")
                              : {})}
                            trailing={task.children.length > 0 ? figure(sum, unit) : undefined}
                          />
                          {children.map(({ child, path: childPath }) => (
                            <CheckRow
                              key={childPath}
                              indent
                              checked={taskOn && on(childPath)}
                              disabled={!taskOn}
                              onCheckedChange={(value) => toggle(childPath, value)}
                              name={child.name}
                              note={child.note}
                              meta={strays.has(childPath) ? t(messageKey(strays.get(childPath)!)) : undefined}
                              {...(child.estimate !== null ? amountProps(childPath, child.name, unit ?? "", child.estimate, "task") : {})}
                            />
                          ))}
                        </Fragment>
                      );
                    })}
                  </div>
                </Section>
              ) : null}
            </Flex>
          </Panel>
        );
      })}
      </PanelGrid>

      {failure ? <Notice>{failure}</Notice> : null}

      <ActionBar span={work.goals.length === 1 ? "column" : "full"}>
        {out ? (
          <Flex direction="column" gap="2">
            <Text as="p" variant="sentence" tone="muted">
              {out}
            </Text>
            {createButton}
          </Flex>
        ) : (
          createButton
        )}
      </ActionBar>
    </Flex>
  );

  return (
    <Page width="full">
      <ScreenHeader
        title={t("import.review.title")}
        back={{ href: "/metas/importar", place: t("import.review.place") }}
        eyebrow={eyebrow}
      />
      <ListDetail show="detail" list={source} detail={review} />

      {editing ? (
        <AmountSheet
          key={editing.path}
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={(amount) => {
            const next = withAmount(draft, editing.path, amount);
            setDraft(next);
            saveReview(next, [...unmarked]);
            setEditing(null);
          }}
        />
      ) : null}
    </Page>
  );
}

// 138's amount sheet over the draft in memory: a time unit takes hours and
// minutes as two whole fields, any other unit one. The same schema as the
// month and the task forms judges it, and nothing is written.
function AmountSheet({
  editing,
  onClose,
  onSave,
}: {
  editing: Editing;
  onClose: () => void;
  onSave: (amount: number) => void;
}) {
  const t = useTranslations();
  const timed = isTimeUnit(editing.unit);
  const parts = splitMinutes(editing.amount);
  const [hours, setHours] = useState(String(parts.h));
  const [minutes, setMinutes] = useState(String(parts.min));
  const [single, setSingle] = useState(String(editing.amount));
  const [error, setError] = useState<string | null>(null);

  function save() {
    let typed: number;
    if (timed) {
      const h = hours.trim() === "" ? "0" : hours.trim();
      const min = minutes.trim() === "" ? "0" : minutes.trim();
      if (!WHOLE.test(min) || Number(min) > 59) {
        setError(t("month.errors.minutesInvalid"));
        return;
      }
      typed = WHOLE.test(h) ? Number(h) * 60 + Number(min) : Number.NaN;
    } else {
      typed = WHOLE.test(single.trim()) ? Number(single.trim()) : Number.NaN;
    }
    const parsed = ({ month: monthAmount, task: taskEstimate, rhythm: rhythmAmount })[editing.schema].safeParse(typed);
    if (!parsed.success) {
      setError(t(messageKey(parsed.error.issues[0].message)));
      return;
    }
    onSave(typed);
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label={editing.title}
      title={t(editing.schema === "rhythm" ? "import.review.edit.rhythmTitle" : "import.review.edit.title")}
    >
      {timed ? (
        <Flex gap="3">
          <Field
            label={t("month.plan.hoursLabel")}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            invalid={error !== null}
            autoFocus
          />
          <Field
            label={t("month.plan.minutesLabel")}
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            invalid={error !== null}
            hint={error}
          />
        </Flex>
      ) : (
        <Field
          label={t("month.plan.amountLabel", { unit: editing.unit })}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={single}
          onChange={(event) => setSingle(event.target.value)}
          invalid={error !== null}
          hint={error}
          autoFocus
        />
      )}
      <SheetActions>
        <Button block onClick={save}>
          {t("month.plan.save")}
        </Button>
        <Button block variant="outline" onClick={onClose}>
          {t("month.plan.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
