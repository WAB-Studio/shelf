"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { editHabit } from "@/app/actions/plan";
import { editHabitSchema } from "@/lib/validation/plan";
import { Button, Field, Sheet, SheetActions, TextArea } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

export type EditHabitActionProps = {
  habitId: string;
  name: string;
  note: string | null;
};

/**
 * `HabitoPantalla` (RP-104): «Editar» opens a sheet with the name and the note
 * and nothing else. Cadence, quantity and the months already read stay as they are.
 */
export function EditHabitAction({ habitId, name, note }: EditHabitActionProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nameValue, setNameValue] = useState(name);
  const [noteValue, setNoteValue] = useState(note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ field: "name" | "note" | "form"; key: MessageKey } | null>(null);

  function openSheet() {
    setNameValue(name);
    setNoteValue(note ?? "");
    setError(null);
    setOpen(true);
  }

  async function handleSave() {
    if (pending) return;

    // The action parses again: it takes the typed values, not the parsed ones (a cleared note is null by then).
    const input = { commitmentId: habitId, name: nameValue, note: noteValue };
    const parsed = editHabitSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError({ field: issue.path[0] === "note" ? "note" : "name", key: messageKey(issue.message) });
      return;
    }

    setPending(true);
    setError(null);

    const result = await editHabit(input);
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setError({ field: "form", key: result.error });
    }
  }

  return (
    <>
      <Button variant="outline" onClick={openSheet}>
        {t("habit.edit")}
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        label={name}
        title={t("habit.sheet.title")}
      >
        <Field
          label={t("habit.sheet.nameLabel")}
          value={nameValue}
          onChange={(event) => setNameValue(event.target.value)}
          invalid={error !== null && error.field !== "note"}
          hint={error && error.field !== "note" ? t(error.key) : undefined}
          autoFocus
        />
        <TextArea
          label={t("habit.sheet.noteLabel")}
          rows={3}
          value={noteValue}
          onChange={(event) => setNoteValue(event.target.value)}
          invalid={error?.field === "note"}
          hint={error?.field === "note" ? t(error.key) : undefined}
        />
        <SheetActions>
          <Button block onClick={handleSave} disabled={pending}>
            {pending ? t("habit.sheet.saving") : t("habit.sheet.save")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("habit.sheet.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
