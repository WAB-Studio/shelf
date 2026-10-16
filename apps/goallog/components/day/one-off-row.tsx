"use client";

import { useState, useTransition } from "react";
import { File, FileText } from "lucide-react";
import { useTranslations } from "next-intl";

import { completeOneOff } from "@/app/actions/one-offs";
import { NoteSheet } from "@/components/one-offs/note-sheet";
import { ScheduleSheet } from "@/components/one-offs/schedule-sheet";
import { TaskSheet } from "@/components/plan/task-sheet";
import { IconButton, Mark, Row, Text } from "@/components/ui";

import { dayPhrase } from "@/lib/day/day-phrase";
import { todayInZone } from "@/lib/zone";
import { type MessageKey } from "@/i18n/translator";

export type OneOffRowProps = {
  oneOffId: string;
  name: string;
  // The civil day it is drawn under; the step «Darle otro día» reads «ahora» from it.
  day: string;
  // «del sábado 19»: set only on a one-off carried from a day before the one
  // drawn (RP-19), so today's own read with no second line.
  carriedFrom?: string;
  // The note it holds, never drawn here: only its button is (`HoyNota`).
  note: string | null;
  noteEyebrow: string;
  // Set for a goal's own dated one-off: its sheet then names the goal.
  goalName?: string;
  // The past day it is drawn on (RP-129): the mark writes the fact there, and
  // «Darle otro día» is Hoy's act (RP-61), so neither the sheet entry nor its step is built.
  doneOn?: string;
};

/**
 * A plain errand beside the commitments (RP-19): the same mark, the same
 * 56 px row. Its mark is always drawn empty — there is nothing left to
 * distinguish once it is on the list, since `completeOneOff` is what takes
 * it off (`app/actions/one-offs.ts`), never a second state drawn here.
 *
 * Two tap targets, two acts (RP-57): the mark still finishes it
 * (`onLeadingClick`), the name opens its sheet (`onClick`) —
 * `Row`'s own split, so neither tap reaches the other's act by mistake.
 */
export function OneOffRow({ oneOffId, name, day, carriedFrom, note, noteEyebrow, goalName, doneOn }: OneOffRowProps) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const today = todayInZone();

  const dayLabel =
    day === today
      ? t("day.choice.today")
      : dayPhrase(
          (key, values) => t(key, values),
          "oneOffs.when",
          day,
          today,
          { weekdays: t.raw("day.weekdayLong") as string[], months: t.raw("day.monthLong") as string[] },
        );

  function handleComplete() {
    if (pending) return;
    setError(null);

    startTransition(() => {
      void completeOneOff({ oneOffId, day: doneOn }).then((result) => {
        if (!result.ok) setError(result.error);
      });
    });
  }

  const noteButton = (
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

  return (
    <>
      <Row
        leading={<Mark state="empty" />}
        leadingLabel={t("oneOffs.markDone", { name })}
        name={name}
        meta={carriedFrom}
        metaVariant="sentence"
        onLeadingClick={handleComplete}
        onClick={() => setSheetOpen(true)}
        end={noteButton}
        disabled={pending}
      />
      {error ? (
        <Text as="p" variant="sentence">
          {t(error)}
        </Text>
      ) : null}
      <NoteSheet
        open={noteOpen}
        onOpenChange={setNoteOpen}
        oneOffId={oneOffId}
        name={name}
        note={note}
        eyebrow={noteEyebrow}
      />
      <TaskSheet
        mode="edit"
        goalName={goalName}
        oneOffId={oneOffId}
        name={name}
        unit={null}
        fixedMonth={null}
        planMonth={null}
        months={[]}
        done={false}
        kind="loose"
        canDelete
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onGiveDay={doneOn ? undefined : () => setScheduleOpen(true)}
        giveDayLabel="oneOffs.sheet.giveOtherDay"
      />
      {doneOn ? null : (
        <ScheduleSheet
          key={day}
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          oneOffId={oneOffId}
          name={name}
          current={{ day, label: dayLabel }}
        />
      )}
    </>
  );
}
