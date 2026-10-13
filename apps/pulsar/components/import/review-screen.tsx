"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { confirmImport } from "@/app/actions/import";
import { strayEstimates } from "@/lib/import/draft";
import { clearDraft, readDraft, saveReview, storedText, type StoredDraft } from "@/lib/import/draft-store";
import { edit, nameKey, reviewTree, type ReviewNode } from "@/lib/import/review";
import { monthsOfSpan } from "@/lib/plan/months";
import { civilDateToDate } from "@/lib/zone";
import { ActionBar, Button, Flex, ListDetail, Notice, Page, ScreenHeader, Section, Text, TextArea } from "@/components/ui";
import { messageKey } from "@/i18n/translator";

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
export function ReviewScreen({ today, openGoalNames }: { today: string; openGoalNames: string[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  // The original text stands beside the tree only from 1024px; below, the page holds none of it.
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
  const [stored, setStored] = useState<StoredDraft | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
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
    });
    return () => {
      live = false;
    };
  }, [router]);

  const review = useMemo(() => (stored ? reviewTree(stored, today, startNames) : null), [stored, today, startNames]);
  const declined = useMemo(() => new Set(stored?.declined ?? []), [stored]);
  const strays = useMemo(() => new Map(stored ? strayEstimates(stored.draft).map((stray) => [stray.path, stray.key] as const) : []), [stored]);
  const repeated = useMemo(() => {
    const open = new Set(startNames.map(nameKey));
    return new Set(review ? review.work.goals.flatMap((goal, g) => (open.has(nameKey(goal.name)) ? [g] : [])) : []);
  }, [review, startNames]);

  if (!stored || !review) return <Page width="full" />;

  function keep(next: StoredDraft, unmarked: ReadonlySet<string>) {
    setStored({ ...next, unmarked: [...unmarked] });
    saveReview(next.draft, [...unmarked], next.declined);
  }

  function toggle(path: string, on: boolean) {
    const next = new Set(review!.unmarked);
    if (on) next.delete(path);
    else next.add(path);
    keep(stored!, next);
  }

  function decide(id: string, decline: boolean) {
    const next = new Set(declined);
    if (decline) next.add(id);
    else next.delete(id);
    keep({ ...stored!, declined: [...next] }, review!.unmarked);
    setAccepted((now) => {
      const rest = new Set(now);
      rest.delete(id);
      return rest;
    });
  }

  const monthWord = (month: string) => format.dateTime(civilDateToDate(`${month}-01`), { month: "long", timeZone: "UTC" });

  function open(node: ReviewNode) {
    const g = Number(node.path.split(".")[1]);
    const goal = review!.work.goals[g];
    const unit = goal.measure?.unit ?? "";
    const base = { path: node.path, eyebrow: goal.name, unit, name: null, amount: null, month: null, months: [] };
    if (node.kind === "rhythm") {
      setEditing({ ...base, kind: "rhythm", eyebrow: t("import.review.edit.rhythmEyebrow", { goal: goal.name }), amount: node.figure?.amount ?? 0 });
    } else if (node.kind === "month") {
      setEditing({ ...base, kind: "month", amount: node.figure?.amount ?? 0 });
    } else if (node.kind === "task" || node.kind === "subTask") {
      const task = goal.tasks[Number(node.path.split(".")[3])];
      const span = goal.horizon > today ? monthsOfSpan(today, goal.horizon).map((entry) => entry.slice(0, 7)) : [];
      const months = span.includes(task.month) ? span : [task.month, ...span];
      setEditing({
        ...base,
        kind: node.kind === "task" ? "task" : "subtask",
        name: node.label,
        amount: node.figure?.amount ?? null,
        month: node.kind === "task" ? task.month : null,
        months,
      });
    } else {
      setEditing({ ...base, kind: node.kind === "phase" ? "phase" : node.kind === "commitment" ? "commitment" : "goal", name: node.label });
    }
  }

  function save(change: Change) {
    const target = editing!;
    setEditing(null);
    if (change.name === undefined && change.amount === undefined && change.month === undefined) return;
    let draft = stored!.draft;
    if (change.name !== undefined) draft = edit(draft, target.path, { name: change.name });
    if (change.amount !== undefined) draft = edit(draft, target.path, { amount: change.amount });
    if (change.month !== undefined) draft = edit(draft, target.path, { month: change.month });
    // A figure the person typed is theirs: the check's proposal for it no longer stands.
    const overridden =
      change.amount === undefined ? [] : stored!.corrections.filter((c) => c.at === target.path && c.declined === "keepsPlan").map((c) => c.id);
    keep({ ...stored!, draft, declined: [...new Set([...stored!.declined, ...overridden])] }, review!.unmarked);
  }

  const goalsKept = review.toSend.goals.length;

  async function confirm() {
    if (pending || goalsKept === 0) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await confirmImport(review!.toSend);
      if (result.ok) {
        confirmed.current = true;
        clearDraft();
        router.push("/metas");
        return;
      }
      setFailure(t(result.error.includes(".errors.") ? messageKey(result.error) : "import.review.failed"));
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

      <ReviewTree
        review={review}
        corrections={stored.corrections}
        notices={stored.notices}
        declined={declined}
        accepted={accepted}
        repeated={repeated}
        strays={strays}
        today={today}
        hasLines={coverage.kind !== "parts"}
        sourceLines={stored.source.lines}
        handlers={{
          disabled: pending,
          onToggle: toggle,
          onEdit: open,
          onDecline: (id) => decide(id, true),
          onUndo: (id) => decide(id, false),
          onAccept: (id) => setAccepted((now) => new Set(now).add(id)),
        }}
      />

      {failure ? <Notice>{failure}</Notice> : null}

      {review.nothingWritable ? null : (
        <ActionBar>
          <Button block onClick={confirm} disabled={pending || goalsKept === 0} aria-busy={pending || undefined}>
            {pending ? t("import.review.creating") : t("import.review.create", { count: goalsKept })}
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
