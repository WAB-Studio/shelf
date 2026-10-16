"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { recordDebtPaymentAction } from "@/app/actions/installment-plans";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Money,
  Select,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import {
  BASE_CURRENCY,
  minorUnitExponent,
  type CurrencyCode,
} from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  recordDebtPaymentSchema,
  type RecordDebtPaymentInput,
} from "@/lib/validation/installment-plan";

// The debt the payment credits, and the assets it may come out of. The screen
// resolves both, so the dialog never reads a stored balance.
export type PaymentDebt = {
  accountId: string;
  name: string;
  owedCents: number;
};

export type PaymentSource = {
  id: string;
  name: string;
  balanceCents: number;
};

export function DebtPaymentDialog({
  open,
  onOpenChange,
  debt,
  currency = BASE_CURRENCY,
  payFrom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  debt: PaymentDebt;
  // The currency the debt bills in: every figure here is read in it, and the
  // amount is typed in its minor unit (RF-121). A caller that names none is on
  // an account that settles in the base currency.
  currency?: CurrencyCode;
  payFrom: PaymentSource[];
}) {
  const t = useTranslations("installments");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("paymentTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            debt, so the amount is always born empty and the date at today. */}
        <PaymentForm
          key={debt.accountId}
          debt={debt}
          currency={currency}
          payFrom={payFrom}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function PaymentForm({
  debt,
  currency,
  payFrom,
  onOpenChange,
}: {
  debt: PaymentDebt;
  currency: CurrencyCode;
  payFrom: PaymentSource[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("installments");
  // Root-scoped: the keys under `common` and `debts` sit outside this namespace.
  const tKey = useTranslations();
  const locale = useLocale();

  const form = useForm<RecordDebtPaymentInput>({
    resolver: zodResolver(recordDebtPaymentSchema),
    defaultValues: {
      fromAccountId: payFrom[0]?.id ?? "",
      // The destination is fixed, never a control: it is the debt the caller
      // opened this on, and the allocation walks that account's lines (RF-82).
      toAccountId: debt.accountId,
      amount: "",
      occurredAt: todayInBogota(),
    },
  });

  const onActionError = useActionErrorToast();

  // The lines the payment closed and what it left over come back from the
  // allocation itself; the remainder is stated here and nowhere else, because
  // nothing stores it — the unpaid lines are the whole record (RF-82).
  const pay = useAction(recordDebtPaymentAction, {
    onSuccess({ data }) {
      const remainderCents = data?.remainderCents ?? 0;

      toast.success(
        t("paymentPaidLines", { count: data?.paidLineIds.length ?? 0 }),
        remainderCents > 0
          ? {
              description: t("paymentRemainder", {
                // JSX cannot travel through `t()`, so the one path from a stored
                // integer to a figure is called straight (RF-121).
                amount: formatMoney(remainderCents, currency, locale),
              }),
            }
          : undefined,
      );
      onOpenChange(false);
    },
    onError: onActionError,
  });

  const isPending = pay.isPending;

  return (
    <form
      onSubmit={form.handleSubmit((values) => pay.execute(values))}
      noValidate
    >
      <FieldGroup>
        <Field>
          <FieldLabel>{tKey("debts.nameLabel")}</FieldLabel>
          <Text size="3">{debt.name}</Text>
        </Field>

        <Field>
          <FieldLabel>{tKey("debts.tableBalance")}</FieldLabel>
          <Text size="3">
            <Money
              minor={debt.owedCents}
              currency={currency}
              size="inherit"
              signed={false}
            />
          </Text>
        </Field>

        {/* Exactly the asset accounts the caller was given: a debt is paid from
            an asset, so no liability is ever on offer here (RF-16). */}
        <Controller
          name="fromAccountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-payment-from">
                {t("fromLabel")}
              </FieldLabel>
              <Select.Root
                size="3"
                value={field.value || undefined}
                onValueChange={field.onChange}
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger
                    id="debt-payment-from"
                    placeholder={t("fromLabel")}
                  />
                </FieldControl>
                <Select.Content position="popper">
                  {payFrom.map((account) => (
                    <Select.Item key={account.id} value={account.id}>
                      {account.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-payment-amount">
                {t("amountLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="debt-payment-amount"
                  size="3"
                  inputMode={minorUnitExponent(currency) > 0 ? "decimal" : "numeric"}
                  autoFocus
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="occurredAt"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-payment-date">
                {t("dateLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="debt-payment-date"
                  size="3"
                  type="date"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button
                type="button"
                variant="soft"
                color="gray"
                disabled={isPending}
              >
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={isPending}>
              {isPending && <Spinner />}
              {t("paymentSave")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
