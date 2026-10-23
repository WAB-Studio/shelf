"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { removeMonthBudget, setMonthBudget } from "@/app/actions/budgets";
import { isTimeUnit, minutesFromFields, splitMinutes } from "@/lib/units/time";
import { setMonthBudgetSchema } from "@/lib/validation/budget";
import { Button, Field, Flex, Sheet, SheetActions } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

/**
 * `MesPlan.dc.html` (RP-28): a month's amount, set, changed or removed. A time
 * unit takes hours and minutes as two whole fields and sends their sum in
 * minutes; any other unit takes one field. The form runs
 * `setMonthBudgetSchema` before the action does.
 */
export function BudgetSheet({
  goalId,
  goalName,
  unit,
  month,
  monthName,
  amount,
  stored = true,
  closeHref,
}: {
  goalId: string;
  goalName: string;
  unit: string;
  // "YYYY-MM"
  month: string;
  monthName: string;
  amount: number | null;
  // False when `amount` is a share of the rhythm: there is no stored budget to remove.
  stored?: boolean;
  closeHref: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const timed = isTimeUnit(unit);
  const parts = splitMinutes(amount ?? 0);
  const [hours, setHours] = useState(amount === null ? "" : String(parts.h));
  const [minutes, setMinutes] = useState(amount === null ? "" : String(parts.min));
  const [single, setSingle] = useState(amount === null ? "" : String(amount));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    router.replace(closeHref);
  }

  function typedAmount(): number | MessageKey {
    if (!timed) {
      const count = minutesFromFields(single, "");
      return count.kind === "minutes" ? count.minutes / 60 : Number.NaN;
    }
    const read = minutesFromFields(hours, minutes);
    if (read.kind === "hoursInvalid") return Number.NaN;
    if (read.kind === "minutesInvalid") return "month.errors.minutesInvalid";
    return read.kind === "minutes" ? read.minutes : 0;
  }

  async function handleSave() {
    if (pending) return;
    const typed = typedAmount();
    if (typeof typed === "string") {
      setError(t(typed));
      return;
    }
    const parsed = setMonthBudgetSchema.safeParse({ goalId, month, amount: typed });
    if (!parsed.success) {
      setError(t(messageKey(parsed.error.issues[0].message)));
      return;
    }

    setPending(true);
    setError(null);
    const result = await setMonthBudget(parsed.data);
    setPending(false);
    if (result.ok) {
      router.refresh();
      close();
    } else {
      setError(t(result.error));
    }
  }

  async function handleRemove() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await removeMonthBudget({ goalId, month });
    setPending(false);
    if (result.ok) {
      router.refresh();
      close();
    } else {
      setError(t(result.error));
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      label={t("month.plan.eyebrow", { goal: goalName, month: monthName })}
      title={t("month.plan.title", { month: monthName })}
    >
      {timed ? (
        <Flex gap="3">
          <Field
            label={t("month.plan.hoursLabel")}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            invalid={error !== null}
            autoFocus
          />
          <Field
            label={t("month.plan.minutesLabel")}
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            invalid={error !== null}
            hint={error}
          />
        </Flex>
      ) : (
        <Field
          label={t("month.plan.amountLabel", { unit })}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={single}
          onChange={(event) => setSingle(event.target.value)}
          invalid={error !== null}
          hint={error}
          autoFocus
        />
      )}
      <SheetActions>
        <Button block onClick={handleSave} disabled={pending}>
          {t("month.plan.save")}
        </Button>
        {amount !== null && stored ? (
          <Button block variant="ghost" onClick={handleRemove} disabled={pending}>
            {t("month.plan.remove", { month: monthName })}
          </Button>
        ) : null}
        <Button block variant="outline" onClick={close} disabled={pending}>
          {t("month.plan.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
