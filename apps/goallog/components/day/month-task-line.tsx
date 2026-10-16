"use client";

import { useState, useTransition } from "react";
import { File, FileText } from "lucide-react";
import { useTranslations } from "next-intl";

import { completeOneOff } from "@/app/actions/one-offs";
import { NoteSheet } from "@/components/one-offs/note-sheet";
import { Button, Figure, Flex, IconButton, Mark, Text } from "@/components/ui";
import { useTimeWords } from "@/components/ui/figure";
import type { MessageKey } from "@/i18n/translator";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";

/**
 * `HoyTareaMes.dc.html`: the goal's next task of the month under its figures,
 * with the mark that completes it. The refresh `completeOneOff` revalidates
 * is what brings the following task in; nothing is advanced here.
 */
export function MonthTaskLine({
  oneOffId,
  name,
  estimate,
  parentName,
  part,
  unit,
  note,
  noteEyebrow,
}: {
  oneOffId: string;
  name: string;
  estimate: number | null;
  // The task is a sub-task: its parent's name rides above its own
  // (`HoyTareaMesSubtarea.dc.html`).
  parentName: string | null;
  // The hours the plan puts in this month for the task; drawn only when the task is split across months.
  part: number | null;
  unit: string;
  // Its button is drawn, never its text (`HoyNota`).
  note: string | null;
  noteEyebrow: string;
}) {
  const t = useTranslations();
  const words = useTimeWords();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  // A sub-task never shows its parent's share (`item.part` is the parent's).
  const splitPart =
    parentName === null && estimate !== null && part !== null && part > 0 && part < estimate ? part : null;

  function handleComplete() {
    if (pending) return;
    setError(null);

    startTransition(() => {
      void completeOneOff({ oneOffId }).then((result) => {
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
      <Flex align="start" gap="2">
        <Flex ml="-1" asChild>
          <Button
            tap={48}
            variant="ghost"
            onClick={handleComplete}
            disabled={pending}
            aria-label={t("day.monthLine.markTask", { name })}
          >
            <Mark state="empty" />
          </Button>
        </Flex>
        <Flex direction="column" gap="1" flexGrow="1" minWidth="0" pt="2">
          {parentName ? (
            <Text variant="sentence">
              {t("day.monthLine.parent", { name: parentName })}
            </Text>
          ) : null}
          <Text variant="name">{name}</Text>
          <Text variant="sentence">
            {splitPart !== null
              ? t.rich("day.monthLine.nextPart", {
                  hours: splitPart,
                  fig: () => <Figure variant="meta" value={Number(splitPart)} unit={unit || undefined} />,
                })
              : unit !== "" && !isTimeUnit(unit)
                ? t("day.monthLine.nextMonth")
                : t("day.monthLine.next")}
          </Text>
        </Flex>
        {isTimeUnit(unit) ? (
          <Flex flexShrink="0" pt="2">
            <Text variant="meta" tone="muted" wrap="nowrap">
              {estimate !== null ? formatQuantity(estimate, unit, words) : t("roadmap.plan.unestimated")}
            </Text>
          </Flex>
        ) : null}
        <Flex mr="-3">{noteButton}</Flex>
      </Flex>
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
    </>
  );
}
