"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, File, FileText, Pin } from "lucide-react";
import { useTranslations } from "next-intl";

import { undoFact } from "@/app/actions/facts";
import { completeOneOff } from "@/app/actions/one-offs";
import { NoteSheet } from "@/components/one-offs/note-sheet";
import { TaskSheet } from "@/components/plan/task-sheet";
import { Flex, IconButton, Mark, Row, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";
import { monthName } from "@/lib/plan/month-name";
import { useTimeWords } from "@/components/ui/figure";
import { formatQuantity } from "@/lib/units/time";
import { todayInZone } from "@/lib/zone";

export type TaskRowProps = {
  oneOffId: string;
  name: string;
  // The fact `undoFact` takes back; set only on a done leaf.
  factId: string | null;
  done: boolean;
  // A parent carries a chevron and no mark: it is done by its children (RP-30).
  parent?: boolean;
  child?: boolean;
  // A sentence, or a mixed line whose figures are `Figure`s.
  meta?: ReactNode;
  trailing?: string;
  // Names the open mark; absent, the month page's «Marcar como hecho».
  markLabel?: string;
  // The task's note, null when it has none (RP-45). A parent carries none.
  note?: string | null;
  // The note sheet's label: «nota · {goal} · {month}».
  noteEyebrow?: string;
  // RP-54: the hours this month holds of a task that runs over several; `from`
  // and `to` are the months it comes from and goes on in, "YYYY-MM" or null.
  part?: { part: number; hours: number; from: string | null; to: string | null };
  // "YYYY-MM" the task is fixed to against a rhythm (RP-51); absent, no pin is drawn.
  fixedMonth?: string;
  // A closed month's (RP-143): the day its mark is dated, or null once the month reads only — no
  // mark, no sheet, the note shown and not opened. Absent, the mark is dated today.
  markDay?: string | null;
  // What the task's sheet reads besides the row's own props (RP-55).
  sheet: {
    goalId: string;
    goalName: string;
    unit: string | null;
    estimate: number | null;
    planMonth: string | null;
    months: string[];
    canDelete: boolean;
    // "YYYY-MM" the task holds, pinned against a plan or not.
    fixedMonth: string | null;
  };
};

/**
 * One task of a month (RP-30): a leaf marks itself done with its mark and is
 * taken back by tapping it done; its name opens the task's sheet (RP-55). A
 * parent has no mark of its own.
 */
export function TaskRow({
  oneOffId,
  name,
  factId,
  done,
  parent,
  child,
  meta,
  trailing,
  markLabel,
  note = null,
  noteEyebrow,
  part,
  fixedMonth,
  markDay,
  sheet,
}: TaskRowProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  function run(act: () => Promise<{ ok: boolean; error?: MessageKey }>) {
    if (pending) return;
    setError(null);
    startTransition(() => {
      void act().then((result) => {
        if (result.ok) router.refresh();
        else setError(result.error ?? "month.errors.invalid");
      });
    });
  }

  const thisYear = todayInZone().slice(0, 4);
  const words = useTimeWords();
  const say = (n: number) => (sheet.unit ? formatQuantity(n, sheet.unit, words) : String(n));
  const partLine = part
    ? part.from !== null && part.to !== null
      ? t("roadmap.plan.continues", { from: monthName(part.from, thisYear), to: monthName(part.to, thisYear) })
      : part.to !== null
        ? t("roadmap.plan.startsHere", { hours: say(part.part), month: monthName(part.to, thisYear) })
        : part.from !== null
          ? t("roadmap.plan.comesFrom", { month: monthName(part.from, thisYear) })
          : null
    : null;
  const pinLine =
    fixedMonth && !done ? (
      <Flex asChild align="center" gap="1">
        <Text as="span" variant="sentence" tone="accent">
          <Pin size={14} aria-hidden />
          {t("roadmap.plan.fixedIn", { month: monthName(fixedMonth, thisYear) })}
        </Text>
      </Flex>
    ) : null;
  const lines = [meta, partLine, pinLine].filter(Boolean);
  const stacked =
    lines.length > 1 ? (
      <Flex asChild direction="column">
        <span>{lines.map((line, index) => <span key={index}>{line}</span>)}</span>
      </Flex>
    ) : (lines[0] as ReactNode);
  // «7 de 30 h»: the unit is said once, on the total, when the part is one bare figure of it.
  const totalSaid = part ? say(part.hours) : "";
  const partSaid = part ? say(part.part) : "";
  const unitTail = /\s\p{L}+$/u.exec(totalSaid)?.[0];
  const partBare = unitTail && partSaid.endsWith(unitTail) && partSaid.split(" ").length === 2 && totalSaid.split(" ").length === 2 ? partSaid.slice(0, -unitTail.length) : partSaid;
  const shownTrailing = part ? t("roadmap.plan.part", { part: partBare, total: totalSaid }) : trailing;

  const trail = shownTrailing ? (
    <Text variant="meta" tone="muted">
      {shownTrailing}
    </Text>
  ) : undefined;

  // A parent is done by its children and carries no note of its own.
  const noteButton = parent ? undefined : (
    <IconButton
      tap={44}
      variant="ghost"
      tone={note ? "accent" : undefined}
      aria-label={t(note ? "oneOffs.note.view" : "oneOffs.note.open", { name })}
      onClick={() => setNoteOpen(true)}
      disabled={pending}
    >
      {note ? <FileText size={18} aria-hidden /> : <File size={18} aria-hidden />}
    </IconButton>
  );
  const locked = markDay === null;
  const noteProps = parent ? {} : { preview: note, end: noteButton };

  let row;
  if (parent) {
    row = (
      <Row
        leading={<ChevronRight size={20} aria-hidden />}
        name={
          <Text as="span" tone={done ? "muted" : undefined}>
            {name}
          </Text>
        }
        meta={stacked}
        metaVariant="sentence"
        trailing={trail}
        data-done={done}
        onClick={() => setSheetOpen(true)}
        still={locked}
        disabled={pending}
      />
    );
  } else if (done) {
    row = (
      <Row
        leading={<Mark state="declared" />}
        leadingLabel={t("day.doneOneOffs.undoLabel", { name })}
        name={
          <Text as="span" tone="muted">
            {name}
          </Text>
        }
        meta={stacked}
        metaVariant="sentence"
        trailing={trail}
        {...noteProps}
        onLeadingClick={() => factId && run(() => undoFact({ factId }))}
        onClick={() => setSheetOpen(true)}
        still={locked}
        disabled={pending}
      />
    );
  } else {
    row = (
      <Row
        leading={<Mark state="empty" />}
        leadingLabel={markLabel ?? t("oneOffs.markDone", { name })}
        name={name}
        meta={stacked}
        metaVariant="sentence"
        trailing={trail}
        {...noteProps}
        onLeadingClick={() => run(() => completeOneOff({ oneOffId, day: markDay ?? undefined }))}
        onClick={() => setSheetOpen(true)}
        still={locked}
        disabled={pending}
      />
    );
  }

  return (
    <Flex direction="column" ml={child ? "30px" : undefined}>
      {row}
      {error ? (
        <Text as="p" variant="sentence" role="alert">
          {t(error)}
        </Text>
      ) : null}
      <TaskSheet
        mode="edit"
        goalId={sheet.goalId}
        goalName={sheet.goalName}
        oneOffId={oneOffId}
        name={name}
        estimate={sheet.estimate}
        unit={sheet.unit}
        fixedMonth={sheet.fixedMonth}
        planMonth={sheet.planMonth}
        months={sheet.months}
        done={done}
        kind={parent ? "parent" : child ? "child" : "task"}
        canDelete={sheet.canDelete}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
      {parent ? null : (
        <NoteSheet
          open={noteOpen}
          onOpenChange={setNoteOpen}
          oneOffId={oneOffId}
          name={name}
          note={note}
          eyebrow={noteEyebrow ?? t("oneOffs.note.eyebrowLoose")}
        />
      )}
    </Flex>
  );
}
