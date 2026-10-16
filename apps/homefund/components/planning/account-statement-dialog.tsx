"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { recordAccountStatementAction } from "@/app/actions/account-statements";
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
  TextField,
} from "@/components/ui";
import { minorUnitExponent, type CurrencyCode } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
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
};

function amountInputMode(currency: CurrencyCode): "decimal" | "numeric" {
  return minorUnitExponent(currency) > 0 ? "decimal" : "numeric";
}

export function AccountStatementDialog({
  open,
  onOpenChange,
  account,
  currency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: StatementAccount;
  currency: CurrencyCode;
}) {
  const t = useTranslations("installments");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("statementRecordTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            account, so the form below is always born with fresh defaults. */}
        <StatementForm
          key={account.id}
          account={account}
          currency={currency}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function StatementForm({
  account,
  currency,
  onOpenChange,
}: {
  account: StatementAccount;
  currency: CurrencyCode;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("installments");
  // Root-scoped: `common.cancel` sits outside this namespace.
  const tKey = useTranslations();
  const isLiability = account.kind === "liability";

  const form = useForm<RecordAccountStatementInput>({
    resolver: zodResolver(recordAccountStatementSchema),
    defaultValues: {
      accountId: account.id,
      currency,
      periodStart: account.nextPeriodStart,
      cutOffDate: todayInBogota(),
      paymentDueDate: null,
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

  const record = useAction(recordAccountStatementAction, {
    onSuccess() {
      toast.success(t("statementRecorded"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  const isPending = record.isPending;

  return (
    <form
      onSubmit={form.handleSubmit((values) => record.execute(values))}
      noValidate
    >
      <FieldGroup>
        <Controller
          name="periodStart"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-period-start">
                {t("statementPeriodStartLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="statement-period-start"
                  size="3"
                  type="date"
                  autoFocus
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="cutOffDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-cut-off">
                {t("statementCutOffLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="statement-cut-off"
                  size="3"
                  type="date"
                  disabled={isPending}
                />
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
                  <TextField.Root
                    id="statement-due-date"
                    size="3"
                    type="date"
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || null)
                    }
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

        <Controller
          name="openingBalance"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-opening">
                <Flex as="span" align="center" gap="1">
                  {t("statementOpeningLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="statement-opening"
                  size="3"
                  inputMode={amountInputMode(currency)}
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(event.target.value || null)
                  }
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

        {/* The one figure a statement always closes on (RF-130). */}
        <Controller
          name="closingBalance"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-closing">
                {t("statementClosingLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
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

        <Controller
          name="credits"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-credits">
                <Flex as="span" align="center" gap="1">
                  {t("statementCreditsLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="statement-credits"
                  size="3"
                  inputMode={amountInputMode(currency)}
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(event.target.value || null)
                  }
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

        <Controller
          name="debits"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="statement-debits">
                <Flex as="span" align="center" gap="1">
                  {t("statementDebitsLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="statement-debits"
                  size="3"
                  inputMode={amountInputMode(currency)}
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(event.target.value || null)
                  }
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

        {/* A minimum, an interest and a fee are what a liability's statement
            bills; an asset's statement never carries any of the three. */}
        {isLiability && (
          <Controller
            name="minimumPayment"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="statement-minimum">
                  <Flex as="span" align="center" gap="1">
                    {t("statementMinimumLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="statement-minimum"
                    size="3"
                    inputMode={amountInputMode(currency)}
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || null)
                    }
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

        {isLiability && (
          <Controller
            name="interestCharged"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="statement-interest">
                  <Flex as="span" align="center" gap="1">
                    {t("statementInterestLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="statement-interest"
                    size="3"
                    inputMode={amountInputMode(currency)}
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || null)
                    }
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

        {isLiability && (
          <Controller
            name="feesCharged"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="statement-fees">
                  <Flex as="span" align="center" gap="1">
                    {t("statementFeesLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="statement-fees"
                    size="3"
                    inputMode={amountInputMode(currency)}
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || null)
                    }
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

        <Callout.Root color="jade" variant="soft">
          <Callout.Icon>
            <Info size={16} aria-hidden />
          </Callout.Icon>
          <Callout.Text>{t("statementOptionalHint")}</Callout.Text>
        </Callout.Root>

        <Field>
          <Text size="2" color="gray">
            {t("statementImmutableHint")}
          </Text>
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
              {t("statementRecordSave")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
