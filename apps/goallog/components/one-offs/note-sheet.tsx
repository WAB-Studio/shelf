"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { setOneOffNote } from "@/app/actions/one-offs";
import { noteSchema } from "@/lib/validation/one-off";
import {
  Button,
  Flex,
  Sheet,
  SheetActions,
  Text,
  TextArea,
} from "@/components/ui";

// The count shows only near the cap, so a short note reads without a number.
const COUNT_FROM = 1800;

export type NoteSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oneOffId: string;
  name: string;
  // The note the task holds now; null when it has none.
  note: string | null;
  // The sheet's own label: «nota · {goal} · {month}», or the shorter forms.
  eyebrow: string;
};

/**
 * `TareaNota.dc.html` and its states (RP-45): writes, changes or empties a
 * task's note. A failed save keeps what was typed, never clears it.
 */
export function NoteSheet({
  open,
  onOpenChange,
  oneOffId,
  name,
  note,
  eyebrow,
}: NoteSheetProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(note ?? "");
  const [failed, setFailed] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Every open starts from the note the task holds, never a leftover; adjusted
  // during render so no second paint shows the old text.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText(note ?? "");
      setFailed(false);
    }
  }

  const tooLong = !noteSchema.safeParse(text).success;

  function save(value: string | null) {
    if (pending) return;
    const parsed = noteSchema.safeParse(value ?? "");
    if (!parsed.success) return;
    setFailed(false);
    startTransition(() => {
      void setOneOffNote({ oneOffId, note: parsed.data })
        .then((result) => {
          if (result.ok) {
            onOpenChange(false);
            router.refresh();
          } else setFailed(true);
        })
        .catch(() => setFailed(true));
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} label={eyebrow} title={name}>
      <Flex direction="column" gap="2">
        <TextArea
          label={t("oneOffs.note.label")}
          placeholder={t("oneOffs.note.placeholder")}
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
              {t("oneOffs.note.count", {
                count: String(text.length).replace(/\B(?=(\d{3})+$)/g, " "),
              })}
            </Text>
          </Flex>
        ) : null}
        {tooLong || failed ? (
          <Text as="p" variant="sentence" tone="muted" role="alert">
            {tooLong
              ? t("day.errors.oneOffNoteTooLong")
              : t("oneOffs.note.failed")}
          </Text>
        ) : null}
        {note !== null ? (
          <Flex justify="start">
            <Button
              variant="ghost"
              tone="accent"
              onClick={() => save(null)}
              disabled={pending}
            >
              {t("oneOffs.note.remove")}
            </Button>
          </Flex>
        ) : null}
      </Flex>
      <SheetActions>
        <Button
          block
          onClick={() => save(text)}
          disabled={pending || tooLong}
          aria-busy={pending || undefined}
        >
          {pending ? t("oneOffs.note.saving") : t("oneOffs.note.save")}
        </Button>
        <Button
          block
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          {t("oneOffs.note.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
