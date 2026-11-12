"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { recordThirdPartyPaymentAction } from "@/app/actions/third-party-credits";
import {
  AmountField,
  Button,
  DateInput,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
} from "@/components/ui";
import { minorUnitExponent, type CurrencyCode } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  recordThirdPartyPaymentSchema,
  type RecordThirdPartyPaymentFields,
  type RecordThirdPartyPaymentInput,
} from "@/lib/validation/third-party-credit";

/**
 * «Registrar pago de <persona>» (RF-213): the money the payer sent arriving in one of the person's accounts,
 * booked as a transfer out of their «Me debe». The amount opens at the lender's installment when there is one.
 */
export function ThirdPartyPaymentDialog({
  open,
  onOpenChange,
  credit,
  banks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credit: { liabilityAccountId: string; personName: string; installmentCents: number | null; currency: CurrencyCode };
  // Where the money may have arrived: the person's accounts, never the «Me debe» itself.
  banks: { id: string; name: string }[];
}) {
  const t = useTranslations("thirdPartyCredit");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("paymentTitle", { person: credit.personName })}</Dialog.Title>
        <PaymentForm credit={credit} banks={banks} onOpenChange={onOpenChange} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function PaymentForm({
  credit,
  banks,
  onOpenChange,
}: {
  credit: { liabilityAccountId: string; installmentCents: number | null; currency: CurrencyCode };
  banks: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("thirdPartyCredit");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();
  const locale = useLocale() as Locale;
  // One key per opening: a payment sent again after a lost answer books once.
  const [requestRef] = useState(() => crypto.randomUUID());

  const form = useForm<RecordThirdPartyPaymentFields, unknown, RecordThirdPartyPaymentInput>({
    resolver: zodResolver(recordThirdPartyPaymentSchema),
    defaultValues: {
      liabilityAccountId: credit.liabilityAccountId,
      toAccountId: banks[0]?.id ?? "",
      amount: credit.installmentCents === null ? "" : amountToInput(credit.installmentCents, credit.currency, locale),
      occurredAt: todayInBogota(),
    },
  });

  const record = useAction(recordThirdPartyPaymentAction, {
    onSuccess() {
      toast.success(t("paymentSaved"));
      onOpenChange(false);
    },
    onError: onActionError,
  });
  const isPending = record.isPending;

  return (
    <form onSubmit={form.handleSubmit(() => record.execute({ ...form.getValues(), requestRef }))} noValidate>
      <FieldGroup>
        <Controller
          name="toAccountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="third-party-payment-to">{t("toLabel")}</FieldLabel>
              <Select.Root size="3" value={field.value || undefined} onValueChange={field.onChange} disabled={isPending}>
                <FieldControl>
                  <Select.Trigger id="third-party-payment-to" placeholder={t("toLabel")} />
                </FieldControl>
                <Select.Content position="popper">
                  {banks.map((bank) => (
                    <Select.Item key={bank.id} value={bank.id}>
                      {bank.name}
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
              <FieldLabel htmlFor="third-party-payment-amount">{t("amountLabel")}</FieldLabel>
              <FieldControl>
                <AmountField
                  {...field}
                  id="third-party-payment-amount"
                  size="3"
                  inputMode={minorUnitExponent(credit.currency) > 0 ? "decimal" : "numeric"}
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
              <FieldLabel htmlFor="third-party-payment-date">{t("dateLabel")}</FieldLabel>
              <FieldControl>
                <DateInput {...field} id="third-party-payment-date" size="3" disabled={isPending} />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" disabled={isPending}>
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
