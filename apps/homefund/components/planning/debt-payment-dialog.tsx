"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { recordDebtPaymentAction } from "@/app/actions/installment-plans";
import { deleteTransactionAction } from "@/app/actions/transactions";
import { StartedEarlierOffer } from "@/components/accounts/started-earlier-offer";
import { CreditAndOwedLine, owesBesideCredit } from "@/components/planning/debts-table";
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
  Money,
  SegmentedControl,
  Select,
  Spinner,
  Text,
  TextLink,
  AmountField,
  DateInput,
} from "@/components/ui";
import { OverdraftNotice, PocketNotice, usePocketList } from "@/components/transactions/pocket-notice";
import type { DebtOverviewRow, DebtPocket } from "@/db/queries/debt-overview";
import {
  BASE_CURRENCY,
  minorUnitExponent,
  type CurrencyCode,
} from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { type Locale } from "@/lib/locales";
import { amountToInput, parseAmount } from "@/lib/money";
import { planPocketCover, type PayFromAccount } from "@/lib/pocket-cover";
import { useMoneyText } from "@/lib/use-privacy";
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
  creditCents: number;
  // The pockets in other currencies, which the balance reads beside a credit
  // exactly as the debt's row does (RF-124). None reads as none.
  otherOwed?: DebtPocket[];
  // A card is paid by its minimum or its total; a loan by its instalment, split into interest and
  // capital (RF-281, RF-282). Absent reads as a card.
  loan?: {
    // The payment schedule the bank printed is read for the split.
    hasSchedule: boolean;
    // The terms carry the effective annual rate the split falls back to.
    hasRate: boolean;
    // What the next cuota asks, when the schedule or the terms say.
    instalmentCents: number | null;
  };
  // The period's minimum still owed, and whether what was paid already covers it.
  minimumCents?: number | null;
  minimumPaid?: boolean;
  // What paying the latest statement in full asks now.
  totalDueCents?: number;
};

// The debt a list row pays, as the dialog reads it. The list holds no payment schedule, so a loan's
// instalment is the fixed minimum its terms name.
export function paymentDebtOf(row: {
  accountId: string;
  name: string;
  subtype: string;
  owedCents: number;
  creditCents: number;
  otherOwed: DebtPocket[];
  terms: DebtOverviewRow | null;
}): PaymentDebt {
  const { terms } = row;
  return {
    accountId: row.accountId,
    name: row.name,
    owedCents: row.owedCents,
    creditCents: row.creditCents,
    otherOwed: row.otherOwed,
    minimumCents: terms?.minimumPaymentCents ?? null,
    minimumPaid: terms?.minimumPaid ?? false,
    totalDueCents: terms?.totalDueCents ?? row.owedCents,
    ...(row.subtype === "loan"
      ? { loan: { hasSchedule: false, hasRate: terms !== null, instalmentCents: terms?.minimumPaymentCents ?? null } }
      : {}),
  };
}

export type PaymentSource = PayFromAccount;

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
        <Dialog.Title>{debt.loan ? t("paymentTitleLoan") : t("paymentTitleCard")}</Dialog.Title>
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
  // The words around the amount, which `Money` draws inside its own span.
  const inFavour = tKey("debts.inFavour", { amount: "\u0000" }).split("\u0000");
  const moneyText = useMoneyText();
  const locale = useLocale() as Locale;
  const loan = debt.loan ?? null;
  const minimumCents = debt.minimumCents ?? 0;
  const totalCents = debt.totalDueCents ?? debt.owedCents;
  const instalmentCents = loan?.instalmentCents ?? null;
  const preset = (cents: number) => amountToInput(cents, currency, locale);

  // What the person means to pay: a card's minimum or total, a loan's instalment or an extra payment, or
  // a figure of their own. The amount field always shows the figure; the choice only fills it.
  type Choice = "minimum" | "total" | "other" | "instalment" | "extra";
  const firstChoice: Choice = loan
    ? "instalment"
    : minimumCents > 0
      ? "minimum"
      : totalCents > 0
        ? "total"
        : "other";
  const [choice, setChoice] = useState<Choice>(firstChoice);
  const firstAmount =
    firstChoice === "minimum"
      ? preset(minimumCents)
      : firstChoice === "total"
        ? preset(totalCents)
        : firstChoice === "instalment" && instalmentCents !== null
          ? preset(instalmentCents)
          : "";

  // One key per opening: a payment sent again after a lost answer carries the same one, and
  // the form unmounts on close, so the next opening mints its own.
  const [requestRef] = useState(() => crypto.randomUUID());

  const form = useForm<RecordDebtPaymentInput>({
    resolver: zodResolver(recordDebtPaymentSchema),
    defaultValues: {
      fromAccountId: payFrom[0]?.id ?? "",
      // The destination is fixed, never a control: it is the debt the caller
      // opened this on.
      toAccountId: debt.accountId,
      amount: firstAmount,
      occurredAt: todayInBogota(),
    },
  });

  function choose(next: Choice) {
    setChoice(next);
    const cents =
      next === "minimum" ? minimumCents : next === "total" ? totalCents : next === "instalment" ? instalmentCents : null;
    if (cents !== null) form.setValue("amount", preset(cents), { shouldValidate: form.formState.isSubmitted });
    else if (next === "other") form.setValue("amount", "");
  }

  // The day the server refused as earlier than the debt's opening: the offer to begin the debt earlier shows under
  // it for as long as the date is still that one.
  const [refusedDay, setRefusedDay] = useState<string | null>(null);
  const day = useWatch({ control: form.control, name: "occurredAt" });

  const typedCents = parseAmount(useWatch({ control: form.control, name: "amount" }));
  // More than the debt asks, which is allowed: the card or the loan is then in credit, and the person is told.
  const overCents = typedCents !== null && typedCents > debt.owedCents ? typedCents - debt.owedCents : 0;

  const onActionError = useActionErrorToast();

  // What the payment will draw from the source's pockets, said before saving and again after (RF-249, RF-276).
  const fromAccountId = useWatch({ control: form.control, name: "fromAccountId" });
  const cover = useMemo(() => {
    const source = payFrom.find((one) => one.id === fromAccountId);
    if (!source || typedCents === null || typedCents <= 0) return null;

    const plan = planPocketCover({
      amountCents: typedCents,
      freeCents: source.balanceCents,
      pockets: source.pockets,
      occurredOn: day,
    });
    const left = source.balanceCents - typedCents + plan.totalCents;
    return {
      plan: plan.totalCents > 0 ? plan : null,
      overdraft: left < 0 ? { accountName: source.name, balanceCents: left } : null,
    };
  }, [payFrom, fromAccountId, typedCents, day]);
  const pocketList = usePocketList(cover?.plan ?? null, currency);
  const remove = useAction(deleteTransactionAction, { onError: onActionError });
  const pay = useAction(recordDebtPaymentAction, {
    onError(result) {
      if (result.error.serverError === "errors.movementBeforeOpening") {
        form.setError("occurredAt", { type: "server", message: "errors.movementBeforeOpening" });
        setRefusedDay(form.getValues("occurredAt"));
      } else onActionError(result);
    },
  });

  // «Deshacer» removes what was just written, and with it what the database drew from a pocket.
  function saved(
    data: { transactionId: string; interestCents: number; capitalCents: number } | undefined,
    list: string | null,
  ) {
    const message =
      data && data.interestCents > 0
        ? t("paymentSavedSplit", {
            capital: moneyText(data.capitalCents, currency, locale),
            interest: moneyText(data.interestCents, currency, locale),
          })
        : t("paymentSaved");
    const transactionId = data?.transactionId;
    if (list && transactionId) {
      toast.success(`${message} ${t("paymentSavedPocket", { list })}`, {
        action: { label: tKey("transactions.undo"), onClick: () => remove.execute({ transactionId }) },
      });
    } else {
      toast.success(message);
    }
    onOpenChange(false);
  }

  const isPending = pay.isPending;
  const submit = form.handleSubmit((values) => {
    const list = pocketList;
    void pay
      .executeAsync({ ...values, requestRef, ...(choice === "extra" ? { extra: true } : {}) })
      .then((result) => {
        if (result?.data) saved(result.data, list);
      });
  });

  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel>{tKey("debts.nameLabel")}</FieldLabel>
          <Text size="3">{debt.name}</Text>
        </Field>

        <Field>
          <FieldLabel>{tKey("debts.tableBalance")}</FieldLabel>
          <Text size="3">
            {owesBesideCredit(debt.creditCents, debt.otherOwed ?? []) ? (
              <CreditAndOwedLine
                creditCents={debt.creditCents}
                currency={currency}
                otherOwed={debt.otherOwed ?? []}
                align="left"
                size="3"
                owedBold
              />
            ) : debt.creditCents > 0 ? (
              <Money
                minor={debt.creditCents}
                currency={currency}
                tone="credit"
                size="inherit"
                words={{
                  before: inFavour[0],
                  after: inFavour[1] ?? "",
                }}
              />
            ) : (
              <Money
                minor={debt.owedCents}
                currency={currency}
                size="inherit"
                signed={false}
              />
            )}
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

        <Field>
          <FieldLabel id="debt-payment-choice-label">{t("howMuchLabel")}</FieldLabel>
          <SegmentedControl.Root
            size="3"
            value={choice}
            onValueChange={(next) => choose(next as Choice)}
            aria-labelledby="debt-payment-choice-label"
            disabled={isPending}
          >
            {loan ? (
              <>
                <SegmentedControl.Item value="instalment">
                  {instalmentCents === null
                    ? t("choiceInstalment")
                    : t("choiceInstalmentOf", { amount: moneyText(instalmentCents, currency, locale) })}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="extra">{t("choiceExtra")}</SegmentedControl.Item>
              </>
            ) : (
              <>
                {minimumCents > 0 && (
                  <SegmentedControl.Item value="minimum">
                    {t("choiceMinimum", { amount: moneyText(minimumCents, currency, locale) })}
                  </SegmentedControl.Item>
                )}
                {totalCents > 0 && (
                  <SegmentedControl.Item value="total">
                    {t("choiceTotal", { amount: moneyText(totalCents, currency, locale) })}
                  </SegmentedControl.Item>
                )}
                <SegmentedControl.Item value="other">{t("choiceOther")}</SegmentedControl.Item>
              </>
            )}
          </SegmentedControl.Root>
          {!loan && debt.minimumPaid && (
            <Text size="2" color="gray">
              {t("minimumAlreadyPaid")}
            </Text>
          )}
        </Field>

        <Controller
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-payment-amount">
                {t("amountLabel")}
              </FieldLabel>
              <FieldControl>
                <AmountField
                  {...field}
                  id="debt-payment-amount"
                  size="3"
                  inputMode={minorUnitExponent(currency) > 0 ? "decimal" : "numeric"}
                  autoFocus
                  disabled={isPending}
                  onChange={(event) => {
                    field.onChange(event);
                    if (!loan) setChoice("other");
                  }}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {pocketList && <PocketNotice list={pocketList} />}
        {cover?.overdraft && <OverdraftNotice {...cover.overdraft} currency={currency} />}

        {overCents > 0 && (
          <Callout.Root color="amber" variant="soft" role="status">
            <Callout.Text>{t("overpayWarning", { amount: moneyText(overCents, currency, locale) })}</Callout.Text>
          </Callout.Root>
        )}

        {loan && choice === "instalment" && (
          <Text size="2" color="gray">
            {loan.hasSchedule ? (
              t("splitFromSchedule")
            ) : loan.hasRate ? (
              t("splitFromRate")
            ) : (
              <>
                {t("noRate")}{" "}
                <TextLink href="/planning/debts">{t("noRateLink")}</TextLink>
              </>
            )}
          </Text>
        )}
        {loan && choice === "extra" && (
          <Text size="2" color="gray">
            {t("extraNote")}
          </Text>
        )}

        <Controller
          name="occurredAt"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-payment-date">
                {t("dateLabel")}
              </FieldLabel>
              <FieldControl>
                <DateInput
                  {...field}
                  id="debt-payment-date"
                  size="3"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {refusedDay !== null && refusedDay === day && (
          <StartedEarlierOffer
            accountIds={[debt.accountId]}
            occurredAt={day}
            onMoved={() => {
              setRefusedDay(null);
              form.clearErrors("occurredAt");
              void submit();
            }}
          />
        )}

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
