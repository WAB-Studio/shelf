"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, type Control } from "react-hook-form";
import { toast } from "sonner";

import {
  recordAccountStatementAction,
  reviseAccountStatementAction,
} from "@/app/actions/account-statements";
import {
  Button,
  Callout,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Spinner,
  Text,
  AmountField,
  DateInput,
} from "@/components/ui";
import type { AccountStatementRow } from "@/db/queries/account-statements";
import { minorUnitExponent, type CurrencyCode } from "@/lib/currency";
import { nextDayOfMonthOnOrAfter, previousDayOfMonthOnOrBefore, todayInBogota, addCivilDays } from "@/lib/dates";
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  recordAccountStatementSchema,
  type RecordAccountStatementInput,
} from "@/lib/validation/account-statement";

// The account a statement closes, for either side of the ledger (RF-129). Its
// kind decides which four fields a liability's statement prints and an
// asset's never does — a savings account owes no minimum and accrues no fee.
export type StatementAccount = {
  id: string;
  name: string;
  kind: "asset" | "liability";
  // The day after the last cut-off, or the account's opening day when none
  // exists yet — the period this statement is assumed to close.
  nextPeriodStart: string;
  // The last recorded cut-off, from which the next one is proposed; null before any statement.
  lastCutOffDate?: string | null;
  // The days of the month the terms name for a cut-off and for the payment falling due.
  cutOffDay?: number | null;
  dueDay?: number | null;
};

function amountInputMode(currency: CurrencyCode): "decimal" | "numeric" {
  return minorUnitExponent(currency) > 0 ? "decimal" : "numeric";
}

export function AccountStatementDialog({
  open,
  onOpenChange,
  account,
  currency,
  statement,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: StatementAccount;
  currency: CurrencyCode;
  // The last statement, to correct it; absent records a new one (RF-284).
  statement?: AccountStatementRow;
}) {
  const t = useTranslations("installments");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{statement ? t("statementEditTitle") : t("statementRecordTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            account, so the form below is always born with fresh defaults. */}
        <StatementForm
          key={account.id}
          account={account}
          currency={currency}
          statement={statement}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

// The cut-off and due dates the terms' days propose: the first cut-off after the last statement (the latest one
// on or before today when none exists), and the first payment day after it.
function proposedDates(account: StatementAccount): { cutOff: string; due: string | null } {
  const today = todayInBogota();
  const cutOff =
    account.cutOffDay == null
      ? today
      : account.lastCutOffDate
        ? nextDayOfMonthOnOrAfter(account.cutOffDay, addCivilDays(account.lastCutOffDate, 1))
        : previousDayOfMonthOnOrBefore(account.cutOffDay, today);
  const due = account.dueDay == null ? null : nextDayOfMonthOnOrAfter(account.dueDay, addCivilDays(cutOff, 1));
  return { cutOff, due };
}

// A figure a statement may not have printed: blank travels as null, never as a zero.
function OptionalFigure({
  name,
  control,
  id,
  label,
  currency,
  disabled,
}: {
  name: "minimumPayment" | "interestCharged" | "feesCharged";
  control: Control<RecordAccountStatementInput>;
  id: string;
  label: string;
  currency: CurrencyCode;
  disabled: boolean;
}) {
  const tKey = useTranslations();
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>
            <Flex as="span" align="center" gap="1">
              {label}
              <Text size="2" weight="regular" color="gray">
                {tKey("common.optional")}
              </Text>
            </Flex>
          </FieldLabel>
          <FieldControl>
            <AmountField
              id={id}
              size="3"
              inputMode={amountInputMode(currency)}
              value={field.value ?? ""}
              onChange={(event) => field.onChange(event.target.value || null)}
              onBlur={field.onBlur}
              name={field.name}
              ref={field.ref}
              disabled={disabled}
            />
          </FieldControl>
          <FieldMessage error={fieldState.error} />
        </Field>
      )}
    />
  );
}

// What a statement prints: its cut-off, when it falls due, its total, the minimum, and the interest and fees it
// charged. The period it opens and the movements it sums are the app's to know, so they are never asked.
function StatementForm({
  account,
  currency,
  statement,
  onOpenChange,
}: {
  account: StatementAccount;
  currency: CurrencyCode;
  statement: AccountStatementRow | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("installments");
  // Root-scoped: `common.cancel` sits outside this namespace.
  const tKey = useTranslations();
  const locale = useLocale();
  const isLiability = account.kind === "liability";
  const proposal = proposedDates(account);
  // A stored figure back in the field, as the unsigned magnitude the statement itself shows.
  const shown = (cents: number | null) => (cents === null ? null : amountToInput(Math.abs(cents), currency, locale));

  const form = useForm<RecordAccountStatementInput>({
    resolver: zodResolver(recordAccountStatementSchema),
    defaultValues: statement
      ? {
          accountId: account.id,
          currency,
          periodStart: statement.periodStart,
          cutOffDate: statement.cutOffDate,
          paymentDueDate: statement.paymentDueDate,
          openingBalance: shown(statement.openingBalanceCents),
          closingBalance: shown(statement.closingBalanceCents) ?? "",
          credits: shown(statement.creditsCents),
          debits: shown(statement.debitsCents),
          minimumPayment: shown(statement.minimumPaymentCents),
          interestCharged: shown(statement.interestChargedCents),
          feesCharged: shown(statement.feesChargedCents),
        }
      : {
          accountId: account.id,
          currency,
          periodStart: account.nextPeriodStart,
          cutOffDate: proposal.cutOff,
          paymentDueDate: isLiability ? proposal.due : null,
          openingBalance: null,
          closingBalance: "",
          credits: null,
          debits: null,
          minimumPayment: null,
          interestCharged: null,
          feesCharged: null,
        },
  });

  const onActionError = useActionErrorToast();

  const onSuccess = () => {
    toast.success(statement ? t("statementEdited") : t("statementRecorded"));
    onOpenChange(false);
  };
  const record = useAction(recordAccountStatementAction, { onSuccess, onError: onActionError });
  const revise = useAction(reviseAccountStatementAction, { onSuccess, onError: onActionError });

  const isPending = record.isPending || revise.isPending;

  return (
    <form
      onSubmit={form.handleSubmit((values) => {
        // The period opens where the last one closed, and never after the cut-off typed.
        const periodStart = values.periodStart > values.cutOffDate ? values.cutOffDate : values.periodStart;
        const payload = { ...values, periodStart };
        if (statement) revise.execute({ ...payload, statementId: statement.id });
        else record.execute(payload);
      })}
      noValidate
    >
      <FieldGroup>
        <Controller
          name="cutOffDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-cut-off">{t("statementCutOffLabel")}</FieldLabel>
              <FieldControl>
                <DateInput {...field} id="statement-cut-off" size="3" autoFocus disabled={isPending} />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* A liability's statement prints when the payment falls due; an
            asset closes a period with no bill behind it (RF-129, RF-130). */}
        {isLiability && (
          <Controller
            name="paymentDueDate"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="statement-due-date">
                  <Flex as="span" align="center" gap="1">
                    {t("statementDueDateLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <DateInput
                    id="statement-due-date"
                    size="3"
                    value={field.value ?? ""}
                    onChange={(event) => field.onChange(event.target.value || null)}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {/* The one figure a statement always closes on (RF-130). */}
        <Controller
          name="closingBalance"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-closing">
                {isLiability ? t("statementTotalLabel") : t("statementClosingLabel")}
              </FieldLabel>
              <FieldControl>
                <AmountField
                  {...field}
                  id="statement-closing"
                  size="3"
                  inputMode={amountInputMode(currency)}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {isLiability && (
          <>
            <OptionalFigure
              name="minimumPayment"
              control={form.control}
              id="statement-minimum"
              label={t("statementMinimumLabel")}
              currency={currency}
              disabled={isPending}
            />
            <OptionalFigure
              name="interestCharged"
              control={form.control}
              id="statement-interest"
              label={t("statementInterestLabel")}
              currency={currency}
              disabled={isPending}
            />
            <OptionalFigure
              name="feesCharged"
              control={form.control}
              id="statement-fees"
              label={t("statementFeesLabel")}
              currency={currency}
              disabled={isPending}
            />
          </>
        )}

        <Callout.Root color="jade" variant="soft">
          <Callout.Icon>
            <Info size={16} aria-hidden />
          </Callout.Icon>
          <Callout.Text>{t("statementOptionalHint")}</Callout.Text>
        </Callout.Root>

        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" disabled={isPending}>
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={isPending}>
              {isPending && <Spinner />}
              {statement ? t("statementEditSave") : t("statementRecordSave")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
