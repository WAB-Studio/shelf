"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { readReconcileSheetAction, reconcileAccountAction } from "@/app/actions/account-reconciliations";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Flex,
  Heading,
  Money,
  Separator,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import type { ReconcileSheet } from "@/db/queries/account-reconciliations";
import { formatMoney } from "@/lib/money";
import { civilDateToDate, isCivilDate, todayInBogota } from "@/lib/dates";
import { useActionErrorToast, type MessageKey } from "@/lib/use-action-toast";
import {
  checkRealAmount,
  reconcileAccountSchema,
  type ReconcileAccountInput,
} from "@/lib/validation/account-reconciliation";

// A server refusal lives beside the field it names; the form keeps what was typed.
type Refusal = { field: "reconciledOn" | "realAmount"; text: string };

export function ReconcileDialog({
  account,
  open,
  onOpenChange,
}: {
  account: AccountRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("accounts");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("reconcileTitle", { name: account.name })}</Dialog.Title>
        {/* Closing unmounts the content, so every opening reads the sheet afresh. */}
        <ReconcileForm key={account.id} account={account} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ReconcileForm({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const currency = account.settlementCurrency;
  const isLiability = account.kind === "liability";

  const form = useForm<ReconcileAccountInput>({
    resolver: zodResolver(reconcileAccountSchema),
    defaultValues: {
      accountId: account.id,
      reconciledOn: todayInBogota(),
      realAmount: "",
      expectedDerivedCents: 0,
    },
  });

  const day = useWatch({ control: form.control, name: "reconciledOn" });
  const realAmount = useWatch({ control: form.control, name: "realAmount" });

  const [sheet, setSheet] = useState<ReconcileSheet | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Bumped to read the same day again after the ledger moved under the dialog.
  const [reads, setReads] = useState(0);
  // Counts confirmations the server accepted.
  const [booked, setBooked] = useState(0);

  const onActionError = useActionErrorToast();

  const reconcile = useAction(reconcileAccountAction, {
    onSuccess({ data }) {
      if (data?.ok) {
        setBooked((n) => n + 1);
        return;
      }

      const messageKey = data?.messageKey ?? "errors.reconcileFailed";
      const named = data?.date
        ? format.dateTime(civilDateToDate(data.date), { day: "numeric", month: "short" })
        : "";
      const stale = messageKey === "errors.reconcileStale";

      setRefusal({
        field:
          data?.date !== undefined || messageKey === "errors.reconcileFutureDay"
            ? "reconciledOn"
            : "realAmount",
        text: tKey(messageKey as MessageKey, { date: named }),
      });
      if (stale) setReads((n) => n + 1);
    },
    onError: onActionError,
  });

  const isPending = reconcile.isPending;

  // The action's `refresh()` commits the list behind the dialog in the transition that wraps the
  // call, after the result lands. A confirmation counts as landed once that commit is done, so the
  // toast and the fresh history never show while the list still reads the old balance.
  const landed = reconcile.isTransitioning && booked > 0 ? booked - 1 : booked;
  useEffect(() => {
    if (landed === 0) return;
    toast.success(t("reconciled"));
    form.setValue("realAmount", "");
  }, [landed, form, t]);

  useEffect(() => {
    if (!isCivilDate(day) || day > todayInBogota()) return;

    let current = true;
    void readReconcileSheetAction({ accountId: account.id, on: day }).then((result) => {
      if (!current) return;
      if (result?.data) {
        setSheet(result.data);
        return;
      }
      toast.error(tKey((result?.serverError ?? "errors.unexpected") as MessageKey));
    });

    return () => {
      current = false;
    };
  }, [account.id, day, reads, landed, tKey]);

  const typed = realAmount === "" ? null : checkRealAmount(realAmount, currency);
  const gapCents =
    typed?.ok && sheet
      ? (isLiability ? -typed.cents : typed.cents) - sheet.account.derivedCents
      : null;

  const dayLabel = (value: string, withYear = false) =>
    format.dateTime(civilDateToDate(value), {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });

  // A figure as the field takes it: an asset as stored, a debt in magnitude, a minus below zero.
  const typedFigure = (cents: number) => {
    const shown = isLiability ? -cents : cents;
    return `${shown < 0 ? "−" : ""}${formatMoney(Math.abs(shown), currency, locale)}`;
  };

  return (
    <form
      onSubmit={form.handleSubmit((values) => {
        if (!sheet) return;
        setRefusal(null);
        reconcile.execute({ ...values, expectedDerivedCents: sheet.account.derivedCents });
      })}
      noValidate
    >
      <FieldGroup>
        <Dialog.Description size="2" color="gray">
          {t("reconcileCurrency", { currency })}
        </Dialog.Description>

        <Controller
          name="reconciledOn"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid || refusal?.field === "reconciledOn"}>
              <FieldLabel htmlFor="reconcile-day">{t("reconcileDay")}</FieldLabel>
              <FieldControl tap>
                <TextField.Root
                  {...field}
                  onChange={(event) => {
                    setRefusal(null);
                    field.onChange(event);
                  }}
                  id="reconcile-day"
                  size="3"
                  type="date"
                  max={todayInBogota()}
                  readOnly={isPending}
                />
              </FieldControl>
              <FieldError
                errors={
                  fieldState.error?.message
                    ? [{ message: tKey(fieldState.error.message as MessageKey) }]
                    : undefined
                }
              >
                {refusal?.field === "reconciledOn" ? refusal.text : undefined}
              </FieldError>
            </Field>
          )}
        />

        {sheet ? (
          <Flex justify="between" align="center" gap="3">
            <Text size="2">{t("reconcileDerived")}</Text>
            <Money minor={sheet.account.derivedCents} currency={currency} tone="plain" />
          </Flex>
        ) : (
          <Flex justify="center">
            <Spinner />
          </Flex>
        )}

        <Controller
          name="realAmount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid || refusal?.field === "realAmount"}>
              <FieldLabel htmlFor="reconcile-real">
                {t(isLiability ? "reconcileRealLiability" : "reconcileRealAsset")}
              </FieldLabel>
              <FieldControl tap>
                <TextField.Root
                  {...field}
                  onChange={(event) => {
                    setRefusal(null);
                    field.onChange(event);
                  }}
                  id="reconcile-real"
                  size="3"
                  inputMode="text"
                  readOnly={isPending}
                />
              </FieldControl>
              <FieldDescription>
                {t(isLiability ? "reconcileRealHintLiability" : "reconcileRealHintAsset")}
              </FieldDescription>
              <FieldError
                errors={
                  fieldState.error?.message
                    ? [{ message: tKey(fieldState.error.message as MessageKey) }]
                    : undefined
                }
              >
                {refusal?.field === "realAmount" ? refusal.text : undefined}
              </FieldError>
            </Field>
          )}
        />

        {gapCents !== null && (
          <Flex direction="column" gap="1">
            <Flex justify="between" align="center" gap="3">
              <Text size="2">{t("reconcileGap")}</Text>
              <Money
                minor={Math.abs(gapCents)}
                currency={currency}
                tone={gapCents > 0 ? "income" : gapCents < 0 ? "expense" : "plain"}
              />
            </Flex>
            <Text size="2" color="gray">
              {gapCents === 0 ? t("reconcileBalanced") : t("reconcileGapHint", { date: dayLabel(day) })}
            </Text>
          </Flex>
        )}

        <Flex gap="3" justify="end">
          <Dialog.Close>
            <Button type="button" size="3" tap variant="ghost" color="gray" disabled={isPending}>
              {tKey("common.cancel")}
            </Button>
          </Dialog.Close>
          <Button type="submit" size="3" tap disabled={isPending || !sheet}>
            {isPending && <Spinner />}
            {isPending ? t("reconcilePending") : t("reconcileSubmit")}
          </Button>
        </Flex>

        <Separator size="4" />

        <Flex direction="column" gap="3">
          <Heading as="h3" size="3">
            {t("reconciliations")}
          </Heading>
          {sheet && sheet.history.length === 0 ? (
            <Text size="2" color="gray">
              {t("reconciliationsEmpty")}
            </Text>
          ) : (
            sheet?.history.map((row) => (
              <Flex key={row.id} direction="column" gap="1">
                <Flex justify="between" align="center" gap="3">
                  <Text size="2" weight="bold">
                    {dayLabel(row.reconciledOn, true)}
                  </Text>
                  {row.gapCents === 0 ? (
                    <Text size="2">{t("reconciliationBalanced")}</Text>
                  ) : (
                    <Money
                      minor={Math.abs(row.gapCents)}
                      currency={currency}
                      tone={row.gapCents > 0 ? "income" : "expense"}
                    />
                  )}
                </Flex>
                <Text size="2" color="gray">
                  {t("reconciliationFigures", {
                    derived: typedFigure(row.derivedCents),
                    real: typedFigure(row.countedCents),
                  })}
                </Text>
              </Flex>
            ))
          )}
        </Flex>
      </FieldGroup>
    </form>
  );
}
