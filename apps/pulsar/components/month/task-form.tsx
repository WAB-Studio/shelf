"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { createOneOff } from "@/app/actions/one-offs";
import { useTimeWords } from "@/components/ui/figure";
import { isTimeUnit, formatQuantity } from "@/lib/units/time";
import { createOneOffSchema } from "@/lib/validation/one-off";
import { Button, Chip, Field, Flex, Page, ScreenHeader, Text } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

const WHOLE = /^\d+$/;

// The shared one-off schema speaks Hoy's field; a month task names its own.
function taskError(key: MessageKey): MessageKey {
  return key === "day.errors.oneOffNameEmpty" ? "month.task.nameEmpty" : key;
}

export type TaskFormProps = {
  goalId: string;
  goalName: string;
  // Null for a goal that measures nothing: the form then carries no amount.
  unit: string | null;
  // "YYYY-MM"
  month: string;
  monthName: string;
  // Present for a sub-task: the parent's name and what its children already sum.
  parent: { id: string; name: string; childTotal: number } | null;
};

/**
 * `TareaNueva`, `SubtareaNueva`, `TareaSinMedida` (RP-30, RP-31, RP-35): a task
 * of a month, or a sub-task under a parent. A time unit takes hours and
 * minutes as two whole fields and sends their sum in minutes; «con
 * sub-tareas» sends no amount, the parent's time being its children's. Runs
 * `createOneOffSchema` before the action does.
 */
export function TaskForm({ goalId, goalName, unit, month, monthName, parent }: TaskFormProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [withChildren, setWithChildren] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  // The field a refusal belongs to; it reads there, under its control.
  const [refused, setRefused] = useState<"name" | "amount">("amount");

  const timed = isTimeUnit(unit);
  const measured = unit !== null;
  const asksAmount = timed && !withChildren;
  const monthHref = `/metas/${goalId}/meses/${month}`;

  // Minutes (or the unit's own count) typed so far; null while blank, NaN for
  // a value that is not a whole number, a message key for minutes past 59.
  function typedAmount(): number | MessageKey | null {
    if (!asksAmount) return null;
    if (hours.trim() === "" && minutes.trim() === "") return null;
    const h = hours.trim() === "" ? "0" : hours.trim();
    const min = minutes.trim() === "" ? "0" : minutes.trim();
    if (!WHOLE.test(h)) return Number.NaN;
    if (!WHOLE.test(min) || Number(min) > 59) return "month.errors.minutesInvalid";
    return Number(h) * 60 + Number(min);
  }

  const words = useTimeWords();
  const typed = typedAmount();
  const sumLine =
    parent && unit
      ? t("month.task.sub.sum", {
          parent: parent.name,
          total: formatQuantity(parent.childTotal + (typeof typed === "number" && !Number.isNaN(typed) ? typed : 0), unit, words),
        })
      : null;

  function refuse(key: MessageKey) {
    setRefused(key === "month.task.nameEmpty" ? "name" : "amount");
    setError(key);
  }

  function handleSubmit() {
    if (pending) return;
    setError(null);

    if (typeof typed === "string") {
      refuse(typed);
      return;
    }
    const estimate = typed !== null && Number.isNaN(typed) ? Number.NaN : typed;
    const parsed = createOneOffSchema.safeParse(
      parent
        ? { name, day: null, parentId: parent.id, estimate }
        : { name, day: null, goalId, plannedMonth: month, estimate },
    );
    if (!parsed.success) {
      refuse(taskError(messageKey(parsed.error.issues[0].message)));
      return;
    }

    startTransition(() => {
      void createOneOff(parsed.data).then((result) => {
        if (result.ok) {
          // A parent with no child yet is a dead end: go on to its first one.
          router.push(!parent && withChildren ? `${monthHref}/tarea/nueva?padre=${result.oneOffId}` : monthHref);
          router.refresh();
        } else {
          refuse(taskError(result.error));
        }
      });
    });
  }

  return (
    <Page>
      <ScreenHeader
        title={parent ? t("month.task.sub.title") : t("month.task.title", { month: monthName })}
        back={{ href: monthHref, place: monthName }}
        eyebrow={t(parent ? "month.task.sub.eyebrow" : "month.task.eyebrow", {
          goal: goalName,
          parent: parent?.name ?? "",
          month: monthName,
        })}
      />

      <Field
        label={t("month.task.nameLabel")}
        value={name}
        onChange={(event) => setName(event.target.value)}
        invalid={error !== null && refused === "name"}
        hint={error !== null && refused === "name" ? t(error) : undefined}
        autoFocus
      />

      {asksAmount ? (
        <Flex gap="3">
          <Field
            label={t("month.task.hoursLabel")}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            suffix={t("month.task.hoursUnit")}
          />
          <Field
            label={t("month.task.minutesLabel")}
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            suffix={t("month.task.minutesUnit")}
            invalid={error !== null && refused === "amount"}
            hint={error !== null && refused === "amount" ? t(error) : undefined}
          />
        </Flex>
      ) : null}

      {sumLine ? (
        <Text as="p" variant="sentence">
          {sumLine}
        </Text>
      ) : null}

      {!measured ? (
        <Text as="p" variant="sentence">
          {t("month.task.noMeasure")}
        </Text>
      ) : null}

      {!parent ? (
        <Flex direction="column" gap="2" align="start">
          <Chip
            checkbox
            selected={withChildren}
            aria-describedby="task-with-children-hint"
            onClick={() => setWithChildren((current) => !current)}
          >
            {t("month.task.withChildren")}
          </Chip>
          <Text as="p" variant="sentence" id="task-with-children-hint">
            {t(timed ? "month.task.withChildrenHint" : "month.task.withChildrenHintNoMeasure")}
          </Text>
        </Flex>
      ) : null}

      <Button block tap={52} onClick={handleSubmit} disabled={pending}>
        {parent ? t("month.task.sub.save") : t("month.task.save")}
      </Button>
      <Button block tap={52} variant="outline" asChild>
        <Link href={monthHref}>{t("month.task.cancel")}</Link>
      </Button>
    </Page>
  );
}
