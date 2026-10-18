"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { recordBilledAmountAction } from "@/app/actions/debt-settlement";
import {
  Button,
  Field,
  FieldControl,
  FieldDescription,
  FieldLabel,
  FieldMessage,
  Flex,
  Money,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { PendingSettlement } from "@/db/queries/debt-statements";
import { minorUnitExponent, type CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import { deriveRate, parseAmount } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  recordBilledAmountSchema,
  type RecordBilledAmountInput,
} from "@/lib/validation/debt-settlement";

// A currency with decimals needs the keypad that types one (RF-121).
function amountInputMode(currency: CurrencyCode): "decimal" | "numeric" {
  return minorUnitExponent(currency) > 0 ? "decimal" : "numeric";
}

const REFUSED_BY_RECONCILIATION = "debts.errors.beforeReconciliation";

/**
 * One purchase waiting for its statement. The rate is the quotient of the two
 * amounts on the row and is stored nowhere (RF-122); it follows the figure being
 * typed as soon as that reads as an amount, so the tasa on screen always divides
 * the two cifras beside it.
 */
export function SettlementRow({
  movement,
  accountId,
  currency,
  canWrite,
  hint = false,
  onSaved,
}: {
  movement: PendingSettlement;
  accountId: string;
  currency: CurrencyCode;
  canWrite: boolean;
  // The line under the field that says what to type; the dialog draws it.
  hint?: boolean;
  onSaved?: () => void;
}) {
  const t = useTranslations("debts.settlement");
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  const form = useForm<RecordBilledAmountInput>({
    resolver: zodResolver(recordBilledAmountSchema),
    defaultValues: {
      transactionId: movement.id,
      accountId,
      // What the typed string is read in, and what the write refuses to differ
      // from: the same schema validates both ends (RNF-10).
      currency,
      billedAmount: "",
    },
  });

  const save = useAction(recordBilledAmountAction, {
    onSuccess() {
      toast.success(t("saved"), { description: t("replacedEstimate") });
      onSaved?.();
    },
    onError(result) {
      // The reconciliation already counted this purchase: the refusal belongs to
      // the field that would replace it, not to a toast that fades (RF-137).
      if (result.error.serverError === REFUSED_BY_RECONCILIATION) {
        form.setError("billedAmount", { message: REFUSED_BY_RECONCILIATION });
        return;
      }
      onActionError(result);
    },
  });

  const typed = useWatch({ control: form.control, name: "billedAmount" });

  // Both integers are in the scale the columns keep, which is what `deriveRate`
  // divides: the rate is their quotient and lands in no column of its own.
  const spentCents = movement.amountCents;
  const billedCents = parseAmount(typed) ?? movement.counterAmountCents;
  const rate = deriveRate(spentCents, movement.currency, billedCents, currency);

  const occurred = format.dateTime(civilDateToDate(movement.occurredAt), {
    day: "numeric",
    month: "short",
  });

  return (
    <Flex direction="column" gap="2" py="3">
      <Flex align="center" justify="between" gap="4">
        <Text size="2" weight="medium" truncate>
          {movement.description ?? occurred}
        </Text>
        {movement.description !== null && (
          <Text size="2" color="gray">
            {occurred}
          </Text>
        )}
      </Flex>

      <Flex align="center" justify="between" gap="4">
        <Text size="2" color="gray">
          {t("spent")}
        </Text>
        <Text size="2" weight="medium">
          <Money
            minor={spentCents}
            currency={movement.currency}
            signed={false}
            size="inherit"
          />
        </Text>
      </Flex>

      <Flex align="center" justify="between" gap="4">
        <Text size="2" color="gray">
          {t("estimate")}
        </Text>
        <Text size="2" weight="medium">
          <Money
            minor={movement.counterAmountCents}
            currency={currency}
            estimate
            signed={false}
            size="inherit"
          />
        </Text>
      </Flex>

      <Flex align="center" justify="between" gap="4">
        <Text size="2" color="gray">
          {t("rate")}
        </Text>
        <Text size="2" weight="medium">
          {format.number(rate, { maximumFractionDigits: 2 })}
        </Text>
      </Flex>

      {/* Exactly what the policies would admit: a reader sees the two figures and
          is offered no field to replace one with. */}
      {canWrite && (
        <form
          onSubmit={form.handleSubmit((values) => save.execute(values))}
          noValidate
        >
          <Controller
            name="billedAmount"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`billed-${movement.id}`}>
                  {t("billedLabel")}
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id={`billed-${movement.id}`}
                    size="3"
                    inputMode={amountInputMode(currency)}
                    disabled={save.isPending}
                  />
                </FieldControl>
                {hint && !fieldState.error && (
                  <FieldDescription>{t("billedHint")}</FieldDescription>
                )}
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Flex justify="end" pt="2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {t("save")}
            </Button>
          </Flex>
        </form>
      )}
    </Flex>
  );
}
