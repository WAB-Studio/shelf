"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { confirmImport } from "@/app/actions/import";
import { sectionHolder } from "@/lib/import/coverage";
import { srcLines, strayEstimates } from "@/lib/import/draft";
import { clearCreated, describePart, readCreated, saveCreated, type CreatedResult } from "@/lib/import/created-store";
import { clearDraft, readDraft, saveReview, storedText, type ReadDraft } from "@/lib/import/draft-store";
import { edit, editedCorrections, goalHorizonRefusal, remapUnmarked, reviewTree, weekdaysIn, type ReviewNode } from "@/lib/import/review";
import type { GoalSnapshot } from "@/lib/import/differences";
import { monthsOfSpan } from "@/lib/plan/months";
import { monthWord } from "@/lib/plan/month-name";
import { ActionBar, Button, Flex, ListDetail, Notice, Page, ScreenHeader, Section, Text, TextArea } from "@/components/ui";
import { messageKey } from "@/i18n/translator";

import { CreatedScreen } from "./created-screen";
import { EditSheet, type Change, type Editing } from "./edit-sheet";
import { ReviewTree } from "./review-tree";

const WIDE = "(min-width: 1024px)";

function subscribeWide(notify: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

/**
 * `/metas/importar/revisar` (RP-37, RP-89): the plan the reader left, as a tree, every part marked
 * in. What the person unmarks, declines or changes is what `confirmImport` is sent, kept in the
 * tab's storage so a reload loses none of it; nothing reaches the database before «Crear».
 */
export function ReviewScreen({ today, snapshots }: { today: string; snapshots: GoalSnapshot[] }) {
  const t = useTranslations();
  const router = useRouter();
  // The original text stands beside the tree only from 1024px; below, the page holds none of it.
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
  const [stored, setStored] = useState<ReadDraft | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set once the create left parts out; kept in the tab so a reload draws it again.
  const [created, setCreated] = useState<CreatedResult | null>(null);
  // The open goals the draft is first matched against. A server refresh never re-reads them, or the goals this
  // confirm creates would turn the review into updates before it leaves; a stale refusal asks for the one read.
  const [start, setStart] = useState(snapshots);
  const [refreshing, setRefreshing] = useState<GoalSnapshot[] | null>(null);
  if (refreshing !== null && snapshots !== refreshing) {
    setStart(snapshots);
    setRefreshing(null);
  }
  // The goal whose open goal changed under the review, by its place in the draft as drawn.
  const [stale, setStale] = useState<number | null>(null);
  const confirmed = useRef(false);

  // The tab's storage is only there once mounted; the server paints no draft.
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!live || confirmed.current) return;
      const left = readCreated();
      if (left) {
        confirmed.current = true;
        setCreated(left);
        return;
      }
      const read = readDraft();
      if (!read) {
        router.replace("/metas/importar");
        return;
      }
      setStored(read);
    });
    return () => {
      live = false;
    };
  }, [router]);

  const review = useMemo(() => (stored ? reviewTree(stored, today, start) : null), [stored, today, start]);
  const accepted = useMemo(() => new Set(stored?.accepted ?? []), [stored]);
  const declined = useMemo(() => new Set(stored?.declined ?? []), [stored]);
  const strays = useMemo(() => new Map(stored ? strayEstimates(stored.draft).map((stray) => [stray.path, stray.key] as const) : []), [stored]);

  if (created) return <CreatedScreen result={created} />;
  if (!stored || !review) return <Page width="full" />;

  function keep(next: ReadDraft, unmarked: ReadonlySet<string>) {
    setStored({ ...next, unmarked: [...unmarked] });
    saveReview(next.draft, [...unmarked], next.declined, next.corrections, next.accepted);
  }

  function toggle(path: string, on: boolean) {
    const next = new Set(review!.unmarked);
    if (on) next.delete(path);
    else next.add(path);
    keep(stored!, next);
  }

  function toggleMany(paths: string[], on: boolean) {
    const next = new Set(review!.unmarked);
    for (const path of paths) {
      if (on) next.delete(path);
      else next.add(path);
    }
    keep(stored!, next);
  }

  function decide(id: string, decline: boolean, accept = false) {
    const next = new Set(declined);
    if (decline) next.add(id);
    else next.delete(id);
    const taken = new Set(accepted);
    if (accept) taken.add(id);
    else taken.delete(id);
    // A move taken or undone changes where its task lies, and the marks follow it.
    keep({ ...stored!, declined: [...next], accepted: [...taken] }, new Set(remapUnmarked(stored!, next, [...review!.unmarked])));
  }


  function open(node: ReviewNode) {
    const g = Number(node.path.split(".")[1]);
    const goal = review!.work.goals[g];
    const unit = goal.measure?.unit ?? "";
    const base = { path: node.path, eyebrow: goal.name, unit, name: null, amount: null, month: null, months: [], commitment: null, horizon: null };
    if (node.kind === "rhythm") {
      setEditing({ ...base, kind: "rhythm", eyebrow: t("import.review.edit.rhythmEyebrow", { goal: goal.name }), amount: node.figure?.amount ?? 0 });
    } else if (node.kind === "month") {
      setEditing({ ...base, kind: "month", amount: node.figure?.amount ?? 0 });
    } else if (node.kind === "task" || node.kind === "subTask") {
      const task = goal.tasks[Number(node.path.split(".")[3])];
      const span = goal.horizon === null || goal.horizon > today ? monthsOfSpan(today, goal.horizon).map((entry) => entry.slice(0, 7)) : [];
      const months = span.includes(task.month) ? span : [task.month, ...span];
      setEditing({
        ...base,
        kind: node.kind === "task" ? "task" : "subtask",
        name: node.label,
        amount: node.figure?.amount ?? null,
        month: node.kind === "task" ? task.month : null,
        months,
      });
    } else if (node.kind === "commitment") {
      const entry = goal.commitments[Number(node.path.split(".")[3])];
      const found = stored!.source.lines === null ? [] : weekdaysIn(srcLines(entry.src, Infinity).map((n) => stored!.source.lines![n - 1] ?? "").join(" "));
      const read =
        entry.cadenceKind === "times_per_week"
          ? t("goal.cadence.timesPerWeek", { count: entry.cadenceN ?? 0 })
          : entry.cadenceKind === "times_per_month"
            ? t("goal.cadence.timesPerMonth", { count: entry.cadenceN ?? 0 })
            : entry.cadenceKind === "every_n_days"
              ? t("goal.cadence.everyNDays", { n: entry.cadenceN ?? 0 })
              : t("goal.cadence.daily");
      // The plan names one day and the reading did not keep it as days: the sheet says so.
      const saidDay =
        found.length === 1 && entry.cadenceKind !== "weekdays"
          ? { word: found[0].word.charAt(0).toUpperCase() + found[0].word.slice(1), day: (t.raw("goal.cadence.weekdayFull") as string[])[found[0].day - 1] }
          : null;
      setEditing({
        ...base,
        kind: "commitment",
        name: node.label,
        unit: entry.unit ?? unit,
        amount: entry.satisfaction === "quantity" ? entry.targetQuantity : null,
        commitment: { cadence: { kind: entry.cadenceKind, weekdays: entry.cadenceWeekdays ?? [], n: entry.cadenceN }, entry, read, saidDay },
      });
    } else if (node.kind === "goal" || node.kind === "group") {
      const g = Number(node.path.split(".")[1]);
      setEditing({
        ...base,
        kind: "goal",
        name: node.label,
        horizon: { current: goal.horizon, today, refuse: (horizon: string | null) => goalHorizonRefusal(stored!.draft, g, horizon, today) },
      });
    } else {
      setEditing({ ...base, kind: "phase", name: node.label });
    }
  }

  function save(change: Change) {
    const target = editing!;
    setEditing(null);
    if (Object.values(change).every((value) => value === undefined)) return;
    let draft = stored!.draft;
    let corrections = stored!.corrections;
    const apply = (one: Parameters<typeof edit>[2]) => {
      draft = edit(draft, target.path, one);
      corrections = editedCorrections(corrections, target.path, one);
    };
    if (change.name !== undefined) apply({ name: change.name });
    if (change.amount !== undefined) apply({ amount: change.amount });
    if (change.month !== undefined) apply({ month: change.month });
    if (change.cadence !== undefined) apply({ cadence: change.cadence });
    if (change.horizon !== undefined) apply({ horizon: change.horizon });
    // A figure the person typed is theirs: the check's proposal for it no longer stands.
    const overridden =
      change.amount === undefined ? [] : stored!.corrections.filter((c) => c.at === target.path && c.declined === "keepsPlan").map((c) => c.id);
    const gone = new Set(corrections.map((c) => c.id));
    keep(
      { ...stored!, draft, corrections, declined: [...new Set([...stored!.declined, ...overridden])].filter((id) => gone.has(id)) },
      review!.unmarked,
    );
  }

  const goalsKept = review.toSend.goals.length;
  const updating = review.updates.length;
  // Marked goals that are all open goals the plan leaves as they are: nothing to create or update.
  const idle = goalsKept > 0 && review.creating + updating === 0;
  const label =
    updating === 0
      ? t("import.review.create", { count: review.creating })
      : review.creating === 0
        ? t("import.review.updateOnly", { count: updating })
        : t("import.review.createAndUpdate", { created: review.creating, updated: updating });

  async function confirm() {
    if (pending || goalsKept === 0 || idle) return;
    setPending(true);
    setFailure(null);
    setStale(null);
    try {
      const result = await confirmImport({ draft: review!.toSend, updates: review!.updates, requestId: stored!.requestId });
      if (result.ok) {
        confirmed.current = true;
        clearDraft();
        if (result.failed.length > 0) {
          const left = { goals: result.goalIds.length, updated: result.updatedIds.length, parts: result.failed.map((part) => describePart(review!.toSend, part)) };
          saveCreated(left);
          setCreated(left);
          return;
        }
        clearCreated();
        router.push("/metas");
        return;
      }
      if (result.error === "import.errors.reviewStale" && result.at !== undefined) {
        // Nothing was written: the goal says so where it is, and the open goals are read again.
        setStale(review!.drawnAt(Number(result.at.split(".")[1])));
        setRefreshing(snapshots);
        router.refresh();
      } else setFailure(t(result.error.includes(".errors.") ? messageKey(result.error) : "import.review.failed"));
    } catch {
      setFailure(t("import.review.failed"));
    }
    setPending(false);
  }

  const { coverage } = review;
  const countLine =
    coverage.kind === "lines"
      ? t("import.review.count.lines", { total: coverage.total, plan: coverage.plan, notes: coverage.notes, out: coverage.out })
      : coverage.kind === "rows"
        ? t("import.review.count.rows", { total: coverage.total, plan: coverage.plan, notes: coverage.notes, out: coverage.out })
        : t("import.review.count.parts", { total: coverage.total, plan: coverage.plan, notes: coverage.notes, out: coverage.out });
  const fromWhere =
    coverage.kind === "parts"
      ? stored.sourceName === null
        ? t("import.review.sourceFileAnon")
        : /\.pdf$/i.test(stored.sourceName)
          ? t("import.review.sourcePdf")
          : t("import.review.sourceFile", { name: stored.sourceName })
      : null;

  const eyebrow = stored.via === "model" ? t("import.review.eyebrow") : t("import.review.eyebrowTemplate");
  const text = storedText(stored);

  // What the review was read from sits beside it from 1024; a file leaves no text to show.
  const source = (
    <Flex direction="column" gap="5">
      {!wide ? null : text !== null ? (
        <TextArea label={t("import.review.sourceLabel")} readOnly rows={16} value={text} />
      ) : (
        <Section label={t("import.review.sourceLabel")}>
          <Text as="p" variant="sentence" tone="muted">
            {stored.sourceName ? t("import.review.sourceFile", { name: stored.sourceName }) : t("import.review.sourceFileAnon")}
          </Text>
        </Section>
      )}
      <Button asChild block variant="outline">
        <Link href="/metas/importar">{t("import.review.change")}</Link>
      </Button>
    </Flex>
  );

  const detail = (
    <Flex direction="column" gap="6">
      <Flex direction="column" gap="2">
        <Text as="p" variant="sentence" tone="muted">
          {t("import.review.hint")}
        </Text>
        <Text as="p" variant="sentence" tone="ink">
          {fromWhere ? `${fromWhere}: ${countLine}` : countLine}
        </Text>
      </Flex>

      {review.nothingWritable ? <Notice role="note">{t("import.review.nothing")}</Notice> : null}

      {stored.leftOut.length > 0 ? (
        <Flex direction="column" gap="2">
          {stored.leftOut.map((section) => {
            const holder = sectionHolder(stored.draft, section, stored.source, coverage.outLines);
            const words = { heading: section.heading, from: String(section.from), to: String(section.to) };
            return (
              <Text key={`${section.from}-${section.to}`} as="p" variant="sentence" tone="muted">
                {holder ? t("import.review.leftOutInNote", { ...words, goal: holder.goalName }) : t("import.review.leftOut", words)}
              </Text>
            );
          })}
        </Flex>
      ) : null}

      <ReviewTree
        review={review}
        corrections={review.corrections}
        notices={stored.notices}
        declined={declined}
        accepted={accepted}
        repeated={review.ambiguous}
        stale={stale}
        strays={strays}
        today={today}
        hasLines={coverage.kind !== "parts"}
        sourceLines={stored.source.lines}
        handlers={{
          disabled: pending,
          onToggle: toggle,
          onToggleMany: toggleMany,
          onEdit: open,
          onDecline: (id) => decide(id, true),
          onUndo: (id) => decide(id, false, true),
          onAccept: (id) => decide(id, false, true),
        }}
      />

      {failure ? <Notice>{failure}</Notice> : null}

      {review.nothingWritable || idle ? null : (
        <ActionBar>
          <Button block onClick={confirm} disabled={pending || goalsKept === 0} aria-busy={pending || undefined}>
            {pending ? t("import.review.creating") : label}
          </Button>
        </ActionBar>
      )}
    </Flex>
  );

  return (
    <Page width="full">
      <ScreenHeader title={t("import.review.title")} back={{ href: "/metas/importar", place: t("import.review.place") }} eyebrow={eyebrow} />
      <ListDetail show="detail" list={source} detail={detail} />

      {editing ? (
        <EditSheet key={editing.path} editing={editing} monthWord={monthWord} onClose={() => setEditing(null)} onSave={save} />
      ) : null}
    </Page>
  );
}
