"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { createGoal } from "@/app/actions/plan";
import { dayBefore, horizonForWeeks, horizonWeeksOf } from "@/lib/day/weeks";
import { createGoalSchema } from "@/lib/validation/plan";
import { civilDateLabel, todayInZone } from "@/lib/zone";
import { Button, Field, Sheet, SheetActions, Text } from "@/components/ui";
import { messageKey } from "@/i18n/translator";

const weeksSchema = z.coerce.number().int().positive().max(520);

export type CreateInsideActionProps = {
  goalId: string;
  name: string;
  // The upper goal's stored horizon: the first day after it. Null: it never ends.
  horizon: string | null;
  // A large goal takes a small one; a general or lone goal takes a large one.
  kind: "big" | "small";
  variant?: "solid" | "outline" | "ghost" | "quiet";
  // The goal above has a rhythm: the sheet says it stops counting.
  rhythm?: boolean;
};

/**
 * «Añadir meta …» (RP-82, RP-79): a button on a goal's own screen opening a
 * sheet with a name and a weeks count. A goal starts the day it is created, so
 * the count runs from today's week; one that ends after the upper goal is
 * refused here with the room left, before any request leaves.
 */
export function CreateInsideAction({ goalId, name, horizon, kind, variant = "outline", rhythm = false }: CreateInsideActionProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = todayInZone();
  const room = horizon === null ? 520 : horizonWeeksOf(today, horizon);
  const typed = weeksSchema.safeParse(value);
  const pastEnd = typed.success && typed.data > room;
  const newHorizon = typed.success ? horizonForWeeks(today, typed.data) : null;

  const pastEndText =
    horizon === null
      ? ""
      : `${t("tree.errors.endPastAbove", {
          name,
          date: civilDateLabel(dayBefore(horizon)),
        })} ${t("tree.create.upTo", { weeks: room })}`;
  const weeksHint = pastEnd
    ? pastEndText
    : (error ??
      (newHorizon ? t("tree.create.ends", { date: civilDateLabel(dayBefore(newHorizon), true) }) : undefined));

  function openSheet() {
    setTitle("");
    setValue("");
    setError(null);
    setOpen(true);
  }

  async function handleCreate() {
    if (pending || pastEnd) return;
    if (!typed.success) {
      setError(t("goal.errors.horizonWeeksInvalid"));
      return;
    }
    const parsed = createGoalSchema.safeParse({
      name: title,
      horizon: horizonForWeeks(today, typed.data),
      parentId: goalId,
    });
    if (!parsed.success) {
      setError(t(messageKey(parsed.error.issues[0].message)));
      return;
    }

    setPending(true);
    setError(null);
    const result = await createGoal(parsed.data);
    if (result.ok) {
      router.push(`/metas/${result.goalId}`);
      return;
    }
    setPending(false);
    setError(
      t(result.error, {
        name: result.values?.name ?? "",
        date: result.values?.date ? civilDateLabel(result.values.date) : "",
      }),
    );
  }

  return (
    <>
      <Button variant={variant} block tap={44} onClick={openSheet}>
        {t(kind === "big" ? "tree.goal.addBig" : "tree.goal.addSmall")}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        label={name.toLocaleUpperCase("es")}
        title={t(kind === "big" ? "tree.create.titleBig" : "tree.create.titleSmall")}
      >
        <Field label={t("tree.create.name")} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <Field
          label={t("tree.create.weeksFrom", { date: civilDateLabel(today) })}
          type="number"
          inputMode="numeric"
          min={1}
          max={520}
          step={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          invalid={pastEnd || error !== null}
          hint={weeksHint}
        />
        {rhythm ? (
          <Text as="p" variant="sentence" tone="muted">
            {t("tree.create.rhythmNote", { name })}
          </Text>
        ) : null}
        <SheetActions>
          <Button block onClick={handleCreate} disabled={pending || pastEnd}>
            {t("tree.create.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("tree.create.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
