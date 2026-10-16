"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Pencil } from "lucide-react";

import { srcLines, type Correction, type DraftGoal, type ImportDraft, type Notice as DraftNotice, type Src } from "@/lib/import/draft";
import { bySection } from "@/lib/import/sections";
import { cadenceWords, daysWords, rateWords } from "@/lib/import/correction-words";
import { correctionKeys, declinedKeys, noticeKey, outKey, remapped } from "@/lib/import/reason-key";
import { changesAnything, type Difference } from "@/lib/import/differences";
import type { reviewTree, ReviewNode } from "@/lib/import/review";
import { phaseCuts, phaseDrops } from "@/lib/import/draft";
import { dayBefore } from "@/lib/day/weeks";
import { weekdaysSentence } from "@/lib/day/row-phrases";
import { shortMonth } from "@/lib/dates/short-month";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { civilDateToDate } from "@/lib/zone";
import { useTimeWords } from "@/components/ui/figure";
import { Button, CheckRow, Figure, Flex, Fold, Panel, Section, Text } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

type Review = ReturnType<typeof reviewTree>;
type Commitment = DraftGoal["commitments"][number];

const RETURN_MS = 700;

const dayShort = (day: string) => `${Number(day.slice(8, 10))} ${shortMonth(day)} ${day.slice(0, 4)}`;

// The lines of the source a part came from, by its path.
function srcOf(draft: ImportDraft, path: string): Src[] {
  const p = path.split(".");
  const goal = draft.goals[Number(p[1])];
  if (!goal) return [];
  if (p.length === 2) return goal.src;
  const index = Number(p[3]);
  if (p[2] === "phases") return goal.phases[index]?.src ?? [];
  if (p[2] === "months") return goal.months[index]?.src ?? [];
  if (p[2] === "commitments") return goal.commitments[index]?.src ?? [];
  if (p[2] === "tasks") {
    const task = goal.tasks[index];
    if (p[4] === "children") return task?.children[Number(p[5])]?.src ?? [];
    return task?.src ?? [];
  }
  return [];
}

export type TreeHandlers = {
  disabled: boolean;
  onToggle: (path: string, on: boolean) => void;
  onToggleMany: (paths: string[], on: boolean) => void;
  onEdit: (node: ReviewNode) => void;
  onDecline: (id: string) => void;
  onUndo: (id: string) => void;
  onAccept: (id: string) => void;
};

/**
 * The review as one tree (RP-89): a row for each part, its class on the line under it, a
 * correction hanging under its part, then what cannot be created, what no part carries and what
 * the person left out. Every figure comes from `reviewTree`.
 */
export function ReviewTree({
  review,
  corrections,
  notices,
  declined,
  accepted,
  repeated,
  stale,
  strays,
  today,
  hasLines,
  sourceLines,
  handlers,
}: {
  review: Review;
  corrections: Correction[];
  notices: DraftNotice[];
  declined: ReadonlySet<string>;
  accepted: ReadonlySet<string>;
  repeated: ReadonlySet<number>;
  // The goal, by its place in the draft as drawn, whose open goal changed while the person reviewed.
  stale: number | null;
  strays: ReadonlyMap<string, string>;
  today: string;
  hasLines: boolean;
  sourceLines: string[] | null;
  handlers: TreeHandlers;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const words = useTimeWords();
  const { work, nodes, unmarked } = review;

  // A part marked back from «las dejaste fuera» stays there, ticked, a moment before it
  // returns to the tree: the person sees the tap land.
  const [returning, setReturning] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  function markBack(path: string, on: boolean) {
    handlers.onToggle(path, on);
    if (!on) return;
    setReturning((now) => new Set(now).add(path));
    timers.current.push(
      window.setTimeout(() => {
        setReturning((now) => {
          const rest = new Set(now);
          rest.delete(path);
          return rest;
        });
      }, RETURN_MS),
    );
  }

  const fmt = (amount: number, unit: string) => formatQuantity(amount, unit, words);
  const monthWord = (month: string) => format.dateTime(civilDateToDate(`${month}-01`), { month: "long", timeZone: "UTC" });
  const monthName = (month: string) => {
    const word = monthWord(month);
    const name = word.charAt(0).toUpperCase() + word.slice(1);
    return month.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${month.slice(0, 4)}`;
  };
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const dayAndMonth = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "long", timeZone: "UTC" });

  const goalOf = (node: ReviewNode) => work.goals[Number(node.path.split(".")[1])];
  const unitOf = (node: ReviewNode) => goalOf(node).measure?.unit ?? "";
  const goalClass = (node: ReviewNode) => {
    switch (node.level) {
      case "general":
        return t("import.review.tree.general");
      case "large":
        return t("import.review.tree.big");
      case "small":
        return t("import.review.tree.small");
      default:
        return t("import.review.tree.goal");
    }
  };
  const classOf = (node: ReviewNode) => {
    switch (node.kind) {
      case "goal":
      case "group":
        return goalClass(node);
      case "phase":
        return t("import.review.tree.phase");
      case "month":
        return t("import.review.tree.month");
      case "rhythm":
        return t("import.review.tree.rhythm");
      case "commitment":
        return t("import.review.tree.commitment");
      case "task":
        return t("import.review.tree.task");
      case "subTask":
        return t("import.review.tree.subtask");
      case "note":
        return "";
    }
  };

  function cadenceText(commitment: Commitment): string {
    switch (commitment.cadenceKind) {
      case "daily":
        return t("goal.cadence.daily");
      case "weekdays":
        return weekdaysSentence((key, values) => t(key, values), commitment.cadenceWeekdays ?? [], t.raw("goal.cadence.weekdayFull") as string[]);
      case "times_per_week":
        return t("goal.cadence.timesPerWeek", { count: commitment.cadenceN ?? 0 });
      case "every_n_days":
        return commitment.cadenceN === 1 ? t("goal.cadence.daily") : t("goal.cadence.everyNDays", { n: commitment.cadenceN ?? 0 });
      case "times_per_month":
        return t("goal.cadence.timesPerMonth", { count: commitment.cadenceN ?? 0 });
    }
  }

  const partOf = (path: string) => {
    const p = path.split(".");
    const goal = work.goals[Number(p[1])];
    if (p[2] === "commitments") return { commitment: goal.commitments[Number(p[3])] };
    if (p[2] === "tasks") {
      const task = goal.tasks[Number(p[3])];
      return p[4] === "children" ? { task, child: task.children[Number(p[5])] } : { task };
    }
    return {};
  };

  const noteOf = (node: ReviewNode): string | null => {
    const goal = goalOf(node);
    if (node.kind === "goal" || node.kind === "group") return goal.note;
    const part = partOf(node.path);
    if (node.kind === "task") return part.task?.note ?? null;
    if (node.kind === "subTask") return part.child?.note ?? null;
    return null;
  };

  // The line a part was written on, when the source has lines.
  const lineOf = (path: string): number | null => (hasLines ? (srcLines(srcOf(work, path), Infinity)[0] ?? null) : null);

  // What the person wrote on that line, as the board's left-out rows show it.
  const lineText = (path: string): string | null => {
    const line = lineOf(path);
    const text = line === null ? undefined : sourceLines?.[line - 1];
    return text === undefined || text.trim() === "" ? null : text.trim();
  };

  const metaOf = (node: ReviewNode): string => {
    const parts: string[] = [classOf(node)];
    const goal = goalOf(node);
    if (node.kind === "goal" || node.kind === "group") parts.push(goal.horizon === null ? t("import.review.noEnd") : t("import.review.horizonUntil", { date: dayShort(dayBefore(goal.horizon)) }));
    else if (node.kind === "phase") {
      const phase = goal.phases[Number(node.path.split(".")[3])];
      parts.push(`${dayShort(phase.startsOn)} – ${dayShort(phase.endsOn)}`);
    } else if (node.kind === "rhythm") parts.push(isTimeUnit(goal.measure?.unit ?? "") ? t("import.review.rhythmMeta") : t("import.review.rhythmMetaUnit"));
    else if (node.kind === "commitment") {
      const { commitment } = partOf(node.path);
      parts.push(cadenceText(commitment!));
      if (commitment!.satisfaction === "tap") parts.push(t("goal.satisfaction.tap"));
    } else if (node.kind === "task" || node.kind === "subTask") {
      const task = partOf(node.path).task!;
      if (node.doneOn) parts.push(t("import.review.doneOn", { date: dayShort(node.doneOn) }));
      parts.push(monthWord(task.month));
      const stray = strays.get(node.path);
      if (stray) parts.push(t(messageKey(stray)));
    }
    return parts.join(" · ");
  };

  // The line under a blocked or left-out row: where the part was written and which goal holds it.
  const whereOf = (node: ReviewNode): string => {
    const parts: string[] = [];
    const line = lineOf(node.path);
    if (line !== null) parts.push(t("import.review.lineAt", { line }));
    if (node.kind !== "goal" && node.kind !== "group") parts.push(goalOf(node).name);
    parts.push(classOf(node));
    return parts.join(" · ");
  };

  const nameOf = (node: ReviewNode): string => {
    const open = node.kind === "goal" || node.kind === "group" ? review.matched.get(Number(node.path.split(".")[1])) : undefined;
    if (open) return t("import.review.update", { goal: open.name });
    if (node.kind === "month") return monthName(node.label);
    if (node.kind === "rhythm") return t("import.review.rhythmName");
    return node.label;
  };

  const reasonOf = (node: ReviewNode): string => {
    const refusal = node.refusal!;
    const values = refusal.values ?? {};
    switch (refusal.key) {
      case "import.errors.monthBeforeStart":
        return t(remapped["import.errors.monthBeforeStart"], { first: `${monthWord(values.first)} ${values.first.slice(0, 4)}` });
      case "import.errors.monthAfterEnd":
        return t(remapped["import.errors.monthAfterEnd"], { last: dayShort(values.last) });
      case "import.errors.amountNoMeasure":
        return t(remapped["import.errors.amountNoMeasure"]);
      case "import.errors.quantityNoMeasure":
        return t(remapped["import.errors.quantityNoMeasure"]);
      default:
        return t(messageKey(refusal.key), values);
    }
  };

  // ---- Corrections: the words each sentence takes, per code.
  const correctionArgs = (c: Correction, node: ReviewNode): Record<string, string | number> => {
    const goal = goalOf(node);
    const unit = goal.measure?.unit ?? "";
    const v = c.values ?? {};
    const number = (text: string) => (/^\d+$/.test(text) ? fmt(Number(text), unit) : text);
    switch (c.code) {
      case "holderMonthsToNote": {
        const entries = JSON.parse(v.months ?? "[]") as { month: string; amount: number }[];
        const list = entries.map((e) => `${monthName(e.month)} ${fmt(e.amount, unit)}`);
        return { months: list.join(", "), name: goal.name };
      }
      case "holderRhythmToNote":
        return { said: number(c.said), name: goal.name };
      case "monthSumDiffers": {
        const month = v.month ?? "";
        const sums = goal.tasks
          .filter((task) => task.month === month && (task.estimate !== null || task.children.some((child) => child.estimate !== null)))
          .map((task) => (task.children.length > 0 ? task.children.reduce((sum, child) => sum + (child.estimate ?? 0), 0) : (task.estimate ?? 0)));
        const word = monthWord(month);
        return {
          monthCap: word.charAt(0).toUpperCase() + word.slice(1),
          month: word,
          said: fmt(Number(c.said), unit),
          proposed: fmt(Number(c.proposed), unit),
          sum: sums.map((n) => fmt(n, unit)).join(" + "),
        };
      }
      case "monthOverRhythm":
        return { month: monthWord(v.month ?? ""), said: fmt(Number(c.said), unit), proposed: fmt(Number(c.proposed), unit) };
      case "parentEstimateDropped": {
        const task = partOf(node.path).task;
        return { name: node.label, said: `${c.said} ${v.unit ?? ""}`.trim(), count: task?.children.length ?? 0 };
      }
      case "parentEstimateDiffers":
        return { name: node.label, said: `${c.said} ${v.unit ?? ""}`.trim(), proposed: `${c.proposed} ${v.unit ?? ""}`.trim() };
      case "rateToRhythm": {
        const words = rateWords(t, c);
        return { said: words.said, proposed: fmt(Number(c.proposed), unit), rate: words.rate };
      }
      case "holderRhythmToNote":
        return { said: rateWords(t, c).said, name: node.label };
      case "cadenceToWeekdays":
        return {
          said: c.said === "" ? cadenceWords(t, c) : c.said,
          proposed: daysWords(t, c.proposed, t.raw("day.cadence.weekdayName") as string[]),
          name: node.label,
        };
      case "endWithinAbove":
        return { said: dayShort(c.said), proposed: dayShort(c.proposed), above: v.above ?? "" };
      default:
        return { said: c.said, proposed: c.proposed, name: node.label };
    }
  };

  const saidOf = (c: Correction, node: ReviewNode): string => {
    const unit = unitOf(node);
    if (c.code === "monthSumDiffers" || c.code === "monthOverRhythm") return fmt(Number(c.said), unit);
    if (c.code === "parentEstimateDropped" || c.code === "parentEstimateDiffers") return `${c.said} ${c.values?.unit ?? ""}`.trim();
    if (c.code === "rateToRhythm" || c.code === "holderRhythmToNote") return rateWords(t, c).said;
    if (c.code === "cadenceToWeekdays") return c.said === "" ? cadenceWords(t, c) : c.said;
    return c.said;
  };

  function correctionBox(c: Correction, node: ReviewNode) {
    const keys = correctionKeys[c.code];
    const args = correctionArgs(c, node);
    if (declined.has(c.id)) {
      const line =
        c.declined === "keepsPlan"
          ? t(declinedKeys.keepsPlan, { said: saidOf(c, node) })
          : t(declinedKeys.leavesOut, { code: c.code });
      return (
        <Flex key={c.id} direction="column" align="start" gap="2">
          <Text as="p" variant="sentence" tone="muted">
            {line}
          </Text>
          <Button variant="ghost" tone="accent" disabled={handlers.disabled} onClick={() => handlers.onUndo(c.id)}>
            {t("import.review.correction.acceptDeclined")}
          </Button>
        </Flex>
      );
    }
    const lines: [string, string][] = [
      [t("import.review.correction.said"), t(keys.said, args)],
      [t("import.review.correction.proposed"), t(keys.proposed, args)],
      [t("import.review.correction.why"), t(keys.why, args)],
    ];
    return (
      <Panel key={c.id} as="div" bordered>
        <Flex direction="column" gap="3">
          {lines.map(([label, sentence]) => (
            <Flex key={label} direction="column" gap="1">
              <Text as="span" variant="meta" tone="muted">
                {label}
              </Text>
              <Text as="span" variant="body" tone="ink">
                {sentence}
              </Text>
            </Flex>
          ))}
          <Flex gap="3" wrap="wrap">
            {accepted.has(c.id) ? null : (
              <Button disabled={handlers.disabled} onClick={() => handlers.onAccept(c.id)}>
                {t("import.review.correction.accept")}
              </Button>
            )}
            <Button variant="outline" disabled={handlers.disabled} onClick={() => handlers.onDecline(c.id)}>
              {t("import.review.correction.decline")}
            </Button>
          </Flex>
        </Flex>
      </Panel>
    );
  }

  const weekNoticeAt = (notice: DraftNotice): string | null => {
    const g = Number(notice.at.split(".")[1]);
    const goal = work.goals[g];
    const index = goal?.tasks.findIndex((task) => task.week === notice.values.week) ?? -1;
    return index >= 0 ? `goals.${g}.tasks.${index}` : null;
  };

  function noticeBox(notice: DraftNotice, node: ReviewNode) {
    if (notice.code === "rhythmWithoutTasks") {
      return (
        <div key={`${notice.at}:${notice.code}`} role="note">
          <Panel as="div" bordered>
            <Text as="p" variant="body">
              {t(noticeKey[notice.code], { name: notice.values.name, above: notice.values.above })}
            </Text>
          </Panel>
        </div>
      );
    }
    const unit = unitOf(node);
    const found = Number(notice.values.found);
    return (
      <div key={`${notice.at}:${notice.values.week}:${notice.values.rule}`} role="note">
        <Panel as="div" bordered>
          <Text as="p" variant="body">
            {t(noticeKey[notice.code], {
              found: notice.values.found,
              foundAmount: fmt(found, unit),
              week: notice.values.week,
              rule: notice.values.rule,
              expected: fmt(Number(notice.values.expected), unit),
            })}
          </Text>
        </Panel>
      </div>
    );
  }

  // One line of what the import would change in an open goal, from the figures of the draft and of the goal.
  function differenceLine(d: Difference, unit: string): string {
    switch (d.kind) {
      case "horizon":
        return t("import.review.diff.horizon", { to: dayShort(dayBefore(d.to)) });
      case "note":
        return t("import.review.diff.note");
      case "measure":
        return d.kept === "fed" ? t("import.review.diff.measureKept") : t("import.review.diff.measure", { name: d.name, unit: d.unit });
      case "rhythm":
        return t("import.review.diff.rhythm", { amount: fmt(d.to, unit) });
      case "month":
        return t("import.review.diff.month", { amount: fmt(d.amount, unit), month: monthWord(d.month) });
      case "phaseAdded":
      case "phaseChanged":
        return t(`import.review.diff.${d.kind}`, { aim: d.aim, startsOn: dayShort(d.startsOn), endsOn: dayShort(d.endsOn) });
      case "commitmentAdded":
      case "commitmentChanged":
      case "commitmentReplaced":
      case "taskAdded":
      case "taskChanged":
        return t(`import.review.diff.${d.kind}`, { name: d.name });
      case "subTaskAdded":
        return t("import.review.diff.subTaskAdded", { name: d.name, task: d.task });
      case "stays":
        return t("import.review.diff.stays", { count: d.count });
    }
  }

  // What hangs under a node's row: its corrections, a notice, a cut phase, a repeated name.
  function belowOf(node: ReviewNode): ReactNode {
    const items: ReactNode[] = [];
    const g = Number(node.path.split(".")[1]);
    const goal = work.goals[g];
    if ((node.kind === "goal" || node.kind === "group") && repeated.has(g)) {
      items.push(
        <div key="repeated" role="note">
          <Panel as="div" bordered>
            <Text as="p" variant="body">
              {t("import.review.repeated")}
            </Text>
          </Panel>
        </div>,
      );
    }
    if ((node.kind === "goal" || node.kind === "group") && node.marked && review.changes.has(g)) {
      const list = review.changes.get(g)!;
      const goalUnit = goal.measure?.unit ?? review.matched.get(g)?.measure?.unit ?? "";
      items.push(
        <Flex key="changes" direction="column" gap="2">
          {changesAnything(list) ? null : (
            <Text as="p" variant="sentence" tone="muted">
              {t("import.review.noChange")}
            </Text>
          )}
          {list.map((d, i) => (
            <Text key={`${d.kind}:${i}`} as="p" variant="sentence" tone="ink">
              {differenceLine(d, goalUnit)}
            </Text>
          ))}
        </Flex>,
      );
    }
    if ((node.kind === "goal" || node.kind === "group") && stale === g) {
      items.push(
        <div key="stale" role="note">
          <Panel as="div" bordered>
            <Text as="p" variant="body">
              {t("import.errors.reviewStale")}
            </Text>
          </Panel>
        </div>,
      );
    }
    if (node.kind === "phase") {
      const cut = phaseCuts(work, today).find((entry) => entry.path === node.path);
      if (cut) {
        items.push(
          <Text key="cut" as="p" variant="sentence" tone="muted">
            {t.rich("import.review.cutPhase", { aim: cut.aim, date: dayAndMonth(cut.from), ...fig })}
          </Text>,
        );
      }
    }
    for (const c of corrections) {
      if (nearest(c.at) === node.path) items.push(correctionBox(c, node));
    }
    for (const notice of notices) {
      const at = weekNoticeAt(notice);
      if ((at ?? `goals.${notice.at.split(".")[1]}`) === node.path) items.push(noticeBox(notice, node));
    }
    if ((node.kind === "goal" || node.kind === "group") && goal) {
      for (const drop of phaseDrops(work, today)) {
        if (drop.path.startsWith(`goals.${g}.phases.`)) {
          items.push(
            <Text key={drop.path} as="p" variant="sentence" tone="muted">
              {t("import.review.droppedPhase", { aim: drop.aim })}
            </Text>,
          );
        }
      }
    }
    return items.length > 0 ? (
      <Flex direction="column" gap="3" width="100%">
        {items}
      </Flex>
    ) : undefined;
  }

  // The node a correction hangs on: its own path, or the nearest one above it that is drawn.
  const paths = new Set(nodes.map((n) => n.path));
  function nearest(at: string): string {
    const parts = at.split(".");
    while (parts.length > 1 && !paths.has(parts.join("."))) parts.pop();
    return parts.join(".");
  }

  function row(node: ReviewNode, depth: number, blocked = false, summary?: string): ReactNode {
    const unit = node.figure?.unit ?? unitOf(node);
    const name = nameOf(node);
    const note = noteOf(node);
    const inherited = !node.marked && !unmarked.has(node.path);
    const task = node.kind === "task" ? partOf(node.path).task : undefined;
    const sum =
      task && task.children.length > 0
        ? nodes
            .filter((n) => n.kind === "subTask" && n.path.startsWith(`${node.path}.children.`) && n.marked)
            .reduce((total, n) => total + (n.figure?.amount ?? 0), 0)
        : null;
    const editable = node.kind !== "note";
    const props = blocked
      ? { disabled: true, reason: reasonOf(node), meta: whereOf(node) }
      : {
          disabled: handlers.disabled || inherited,
          meta: metaOf(node),
          foldedNote: note
            ? { label: t("import.review.tree.note", { count: note.split("\n").length }), text: note }
            : undefined,
        };
    const amount =
      node.figure !== null && !blocked
        ? {
            amount: <Figure variant="meta" value={node.figure.amount} unit={unit} />,
            amountLabel:
              node.kind === "rhythm"
                ? t("import.review.rhythmAmountOf", { amount: fmt(node.figure.amount, unit) })
                : t("import.review.amountOf", { name, amount: fmt(node.figure.amount, unit) }),
          }
        : editable && !blocked
          ? { amount: <Pencil size={16} aria-hidden />, amountLabel: t("import.review.tree.editName", { name: node.label }) }
          : {};
    return (
      <CheckRow
        key={node.path}
        depth={depth as 0 | 1 | 2 | 3 | 4}
        checked={node.marked}
        onCheckedChange={(value) => handlers.onToggle(node.path, value)}
        name={name}
        boxLabel={node.kind === "rhythm" ? t("import.review.rhythmOf", { amount: fmt(node.figure?.amount ?? 0, unit) }) : undefined}
        trailing={sum !== null ? <Figure variant="meta" value={sum} unit={unit} /> : node.kind === "commitment" && partOf(node.path).commitment?.targetQuantity != null ? <Figure variant="meta" value={partOf(node.path).commitment!.targetQuantity!} unit={partOf(node.path).commitment!.unit ?? ""} /> : undefined}
        onAmount={() => handlers.onEdit(node)}
        metaMore={summary}
        below={belowOf(node)}
        {...amount}
        {...props}
      />
    );
  }

  // Drawn rows, in the tree's order. A goal is one row with its summary; its parts fold behind
  // «Sus partes», its months fold inside, a task's sub-tasks behind their count.
  const drawn = nodes.filter((n) => n.kind !== "note" && n.markable && !phaseDrops(work, today).some((drop) => drop.path === n.path));
  const undecided = corrections.filter((c) => !declined.has(c.id) && !accepted.has(c.id));
  const monthOfNode = (node: ReviewNode): string | null =>
    node.kind === "month" ? node.label : node.kind === "task" || node.kind === "subTask" ? (partOf(node.path).task?.month ?? null) : null;
  const noticeAnchors = notices.map((notice) => weekNoticeAt(notice) ?? `goals.${notice.at.split(".")[1]}`);

  function taskRows(node: ReviewNode): ReactNode[] {
    const out: ReactNode[] = [row(node, node.depth)];
    const children = drawn.filter((n) => n.kind === "subTask" && n.path.startsWith(`${node.path}.children.`));
    if (children.length > 0) {
      out.push(
        <Fold key={`${node.path}:fold`} depth={Math.min(node.depth + 1, 4) as 1 | 2 | 3 | 4} label={t("import.review.tree.subTasks", { count: children.length })}>
          {children.map((child) => row(child, child.depth))}
        </Fold>,
      );
    }
    return out;
  }

  function monthFold(goal: ReviewNode, month: string, members: ReviewNode[]): ReactNode {
    const monthNode = members.find((n) => n.kind === "month");
    const tasks = members.filter((n) => n.kind === "task");
    const unit = unitOf(goal);
    const reach = new Set(members.flatMap((n) => [n.path, ...drawn.filter((d) => d.path.startsWith(`${n.path}.children.`)).map((d) => d.path)]));
    const pending = undecided.filter((c) => reach.has(nearest(c.at))).length;
    const hours = monthNode?.figure ? monthNode.figure.amount : tasks.reduce((sum, n) => sum + (n.figure?.amount ?? 0), 0);
    const marked = tasks.filter((n) => n.marked);
    const label = [
      monthName(month),
      t("import.review.tree.monthTasks", { count: tasks.length }),
      ...(hours > 0 ? [fmt(hours, unit)] : []),
      ...(pending > 0 ? [t("import.review.tree.summaryPending", { count: pending })] : []),
    ].join(" · ");
    return (
      <Fold key={`${goal.path}:${month}`} depth={Math.min(goal.depth + 2, 4) as 2 | 3 | 4} label={label}>
        {members.flatMap((n) => (n.kind === "task" ? taskRows(n) : [row(n, n.depth)]))}
        {marked.length > 0 ? (
          <Button
            variant="ghost"
            tone="accent"
            disabled={handlers.disabled}
            onClick={() => handlers.onToggleMany(marked.map((n) => n.path), false)}
          >
            {t("import.review.tree.removeMonth", { count: marked.length, month: monthWord(month) })}
          </Button>
        ) : null}
      </Fold>
    );
  }

  function goalRows(node: ReviewNode): ReactNode[] {
    const inside = drawn.filter((n) => n.kind !== "subTask" && n.path.startsWith(`${node.path}.`));
    const head = inside.filter((n) => n.kind !== "month" && n.kind !== "task");
    const byMonth = new Map<string, ReviewNode[]>();
    for (const n of inside) {
      const month = monthOfNode(n);
      if (month !== null) byMonth.set(month, [...(byMonth.get(month) ?? []), n]);
    }
    const g = Number(node.path.split(".")[1]);
    const pending = undecided.filter((c) => Number(c.at.split(".")[1]) === g).length;
    const taskCount = inside.filter((n) => n.kind === "task").length;
    const summary = [
      ...(inside.some((n) => n.kind === "phase") ? [t("import.review.tree.summaryPhases", { count: inside.filter((n) => n.kind === "phase").length })] : []),
      ...(taskCount > 0 ? [t("import.review.tree.summaryTasks", { count: taskCount })] : []),
      ...(inside.some((n) => n.kind === "commitment") ? [t("import.review.tree.summaryCommitments", { count: inside.filter((n) => n.kind === "commitment").length })] : []),
      ...(byMonth.size > 0 ? [t("import.review.tree.summaryMonths", { count: byMonth.size })] : []),
      ...(pending > 0 ? [t("import.review.tree.summaryPending", { count: pending })] : []),
    ].join(" · ");
    const out: ReactNode[] = [row(node, node.depth, false, summary)];
    if (inside.length > 0) {
      const open = pending > 0 || noticeAnchors.some((at) => at === node.path || at.startsWith(`${node.path}.`));
      out.push(
        <Fold key={`${node.path}:parts`} depth={Math.min(node.depth + 1, 4) as 1 | 2 | 3 | 4} defaultOpen={open} label={t("import.review.tree.parts")}>
          {head.map((n) => row(n, n.depth))}
          {[...byMonth.keys()].sort().map((month) => monthFold(node, month, byMonth.get(month)!))}
        </Fold>,
      );
    }
    return out;
  }

  const rows: ReactNode[] = drawn.flatMap((node) => (node.kind === "goal" || node.kind === "group" ? goalRows(node) : []));

  // ---- What is not in the tree.
  // A goal refused whole is one row; what is refused under it is not listed again.
  const goalOut = new Set(nodes.filter((n) => (n.kind === "goal" || n.kind === "group") && n.refusal !== null).map((n) => n.path));
  const blockedNodes = nodes.filter((n) => n.kind !== "note" && n.refusal !== null && (goalOut.has(n.path) || !goalOut.has(n.path.split(".").slice(0, 2).join("."))));
  const parentOf = (index: number): ReviewNode | undefined => {
    for (let k = index - 1; k >= 0; k--) if (nodes[k].depth < nodes[index].depth) return nodes[k];
    return undefined;
  };
  const leftNodes = nodes.filter((n, index) => {
    if (n.kind === "note" || n.kind === "rhythm" || !n.markable) return false;
    if (returning.has(n.path)) return true;
    if (!unmarked.has(n.path)) return false;
    const parent = parentOf(index);
    return parent === undefined || parent.marked;
  });
  const placed = review.coverage.outLines.filter((line) => line.reason === "notPlaced" || line.reason === "noteFull");

  const noteOwner = (line: number): string => {
    for (const goal of work.goals) {
      if (srcLines(goal.noteSrc, Infinity).includes(line)) return goal.name;
      for (const task of goal.tasks) {
        if (srcLines(task.noteSrc, Infinity).includes(line)) return task.name;
        for (const child of task.children) if (srcLines(child.noteSrc, Infinity).includes(line)) return child.name;
      }
    }
    return "";
  };

  const sections = bySection(placed, sourceLines);
  const placedRow = (line: (typeof placed)[number]) => (
    <CheckRow
      key={line.line}
      checked={false}
      disabled
      name={line.text}
      meta={t("import.review.lineAt", { line: line.line })}
      reason={t(outKey[line.reason], { name: noteOwner(line.line) })}
    />
  );

  const section = (title: MessageKey, hint: MessageKey, children: ReactNode) => (
    <Section label={t(title)}>
      <Text as="p" variant="sentence" tone="muted">
        {t(hint)}
      </Text>
      <div>{children}</div>
    </Section>
  );

  return (
    <Flex direction="column" gap="6">
      {rows.length > 0 ? (
        <Panel stacked label={t("import.review.title")}>
          <div>{rows}</div>
        </Panel>
      ) : null}

      {blockedNodes.length > 0
        ? section(
            "import.review.blocked.title",
            "import.review.blocked.hint",
            blockedNodes.map((node) => (
              <Fragment key={node.path}>{row(node, 0, true)}</Fragment>
            )),
          )
        : null}

      {placed.length > 0
        ? section(
            "import.review.unplaced.title",
            "import.review.unplaced.hint",
            sections
              ? sections.map((group) => (
                  <Fold
                    key={group.lines[0].line}
                    label={t("import.review.unplaced.group", { heading: group.heading ?? t("import.review.unplaced.noHeading"), count: group.lines.length })}
                  >
                    {group.lines.map(placedRow)}
                  </Fold>
                ))
              : placed.map(placedRow),
          )
        : null}

      {leftNodes.length > 0
        ? section(
            "import.review.left.title",
            "import.review.left.hint",
            leftNodes.map((node) => {
              const unit = unitOf(node);
              return (
                <CheckRow
                  key={node.path}
                  checked={node.marked}
                  disabled={handlers.disabled}
                  onCheckedChange={(value) => markBack(node.path, value)}
                  name={lineText(node.path) ?? nameOf(node)}
                  meta={`${whereOf(node)}${node.figure ? ` · ${fmt(node.figure.amount, unit)}` : ""}`}
                />
              );
            }),
          )
        : null}
    </Flex>
  );
}
