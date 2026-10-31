"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { setGoalNote } from "@/app/actions/plan";
import { GOAL_NOTE_MAX, setGoalNoteSchema } from "@/lib/validation/plan";
import {
  Button,
  Flex,
  Fold,
  Sheet,
  SheetActions,
  Text,
  TextArea,
} from "@/components/ui";

// The count shows only near the cap, so a short note reads without a number.
const COUNT_FROM = Math.round(GOAL_NOTE_MAX * 0.9);

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, " ");

export type GoalNoteProps = {
  goalId: string;
  // The sheet's title.
  name: string;
  // The note the goal holds now; null when it has none.
  note: string | null;
};

/**
 * `JerarquiaNota` (RP-95): a goal's note, folded as «Nota» with «Cambiar la nota»
 * beneath; with none, «Añadir una nota» stands in its place. The sheet is the
 * task note's: emptying the field and saving removes the note, and a failed
 * save keeps what was typed.
 */
export function GoalNote({ goalId, name, note }: GoalNoteProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(note ?? "");
  const [failed, setFailed] = useState(false);

  const tooLong = !setGoalNoteSchema.shape.note.safeParse(text).success;

  function openSheet() {
    setText(note ?? "");
    setFailed(false);
    setOpen(true);
  }

  function save(value: string) {
    if (pending) return;
    if (!setGoalNoteSchema.shape.note.safeParse(value).success) return;
    setFailed(false);
    startTransition(() => {
      void setGoalNote({ goalId, note: value })
        .then((result) => {
          if (result.ok) {
            setOpen(false);
            router.refresh();
          } else setFailed(true);
        })
        .catch(() => setFailed(true));
    });
  }

  return (
    <>
      {note === null ? (
        <Button variant="quiet" block onClick={openSheet}>
          {t("tree.note.add")}
        </Button>
      ) : (
        <Fold label={t("tree.note.fold")}>
          <Text as="p" variant="sentence" note>
            {note}
          </Text>
          <Flex justify="start">
            <Button variant="ghost" tone="accent" onClick={openSheet}>
              {t("tree.note.change")}
            </Button>
          </Flex>
        </Fold>
      )}
      <Sheet open={open} onOpenChange={setOpen} label={t("tree.note.eyebrow")} title={name}>
        <Flex direction="column" gap="2">
          <TextArea
            label={t("tree.note.label")}
            placeholder={t("tree.note.placeholder")}
            rows={7}
            value={text}
            invalid={tooLong}
            onChange={(event) => {
              setText(event.target.value);
              setFailed(false);
            }}
          />
          {text.length >= COUNT_FROM ? (
            <Flex justify="end">
              <Text variant="meta" tone={tooLong ? "ink" : "muted"}>
                {t("tree.note.count", { count: grouped(text.length), max: grouped(GOAL_NOTE_MAX) })}
              </Text>
            </Flex>
          ) : null}
          {tooLong || failed ? (
            <Text as="p" variant="sentence" tone="muted" role="alert">
              {tooLong ? t("tree.note.tooLong", { max: grouped(GOAL_NOTE_MAX) }) : t("tree.note.failed")}
            </Text>
          ) : null}
          {note !== null ? (
            <Flex justify="start">
              <Button variant="ghost" tone="accent" onClick={() => save("")} disabled={pending}>
                {t("tree.note.remove")}
              </Button>
            </Flex>
          ) : null}
        </Flex>
        <SheetActions>
          <Button block onClick={() => save(text)} disabled={pending || tooLong} aria-busy={pending || undefined}>
            {pending ? t("tree.note.saving") : t("tree.note.save")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("tree.note.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
