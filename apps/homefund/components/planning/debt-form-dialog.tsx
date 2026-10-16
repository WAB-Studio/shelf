"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { createAccountAction } from "@/app/actions/accounts";
import { saveDebtTermsAction } from "@/app/actions/debt-terms";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  SegmentedControl,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import {
  BASE_CURRENCY,
  minorUnitExponent,
  type CurrencyCode,
  type OfferedCurrency,
} from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  ACCOUNT_PLACEMENTS,
  createAccountSchema,
  type CreateAccountInput,
} from "@/lib/validation/account";
import {
  DEBT_KINDS,
  debtTermsSchema,
  type DebtTermsInput,
} from "@/lib/validation/debt-terms";

// A currency with decimals needs the keypad that types one (RF-121).
function amountInputMode(currency: CurrencyCode): "decimal" | "numeric" {
  return minorUnitExponent(currency) > 0 ? "decimal" : "numeric";
}

// The bare liability the "complete" mode writes terms onto: the screen resolves
// its derived balance and passes it in, so the dialog never reads a stored one.
export type DebtAccount = {
  accountId: string;
  name: string;
  owedCents: number;
};

// Create mode owns both an account and its terms, but the account does not exist
// yet: it drops `accountId` from the terms half and lets step one supply it.
// The minimum XOR is enforced by the toggle below, so the server keeps the
// `minimumBothSet` refinement and this half does not repeat it.
const debtTermsShape = Object.fromEntries(
  Object.entries(debtTermsSchema.shape).filter(([key]) => key !== "accountId"),
) as Omit<typeof debtTermsSchema.shape, "accountId">;
const createDebtSchema = z.object({
  ...createAccountSchema.shape,
  ...debtTermsShape,
});

// A superset of both modes' shapes plus the UI-only minimum toggle: the resolver
// strips whichever key the active schema does not declare, so `accountId` never
// reaches the create step and the account fields never reach the terms step.
type DebtFormValues = {
  accountId: string;
  name: string;
  kind: "liability";
  placement: (typeof ACCOUNT_PLACEMENTS)[number];
  institution: string;
  amount: string;
  balanceOn: string;
  debtKind: (typeof DEBT_KINDS)[number];
  annualRate: string;
  // Which minimum the user is entering; drives which input shows and keeps the
  // other value null so a fixed amount and a percentage never coexist.
  minimumMode: "fixed" | "pct";
  minimumPayment: string | null;
  minimumPaymentPct: string | null;
  creditLimit: string | null;
  statementCutOffDay: number | null;
  paymentDueDay: number | null;
  aval: string | null;
};

export function DebtFormDialog({
  open,
  onOpenChange,
  mode,
  hasGroup,
  account,
  currency = BASE_CURRENCY,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "complete";
  hasGroup: boolean;
  account?: DebtAccount;
  // The currency the account settles in: the balance reads in it and the terms
  // are typed in its minor unit (RF-121). A new debt has none yet, so a caller
  // that names none is on the base currency.
  currency?: OfferedCurrency;
}) {
  const t = useTranslations("debts");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>
          {mode === "create" ? t("addTitle") : t("completeTermsTitle")}
        </Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <DebtForm
          key={account?.accountId ?? "create"}
          mode={mode}
          hasGroup={hasGroup}
          account={account}
          currency={currency}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function DebtForm({
  mode,
  hasGroup,
  account,
  currency,
  onOpenChange,
}: {
  mode: "create" | "complete";
  hasGroup: boolean;
  account?: DebtAccount;
  currency: OfferedCurrency;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("debts");
  // Root-scoped: the keys under `common` sit outside the `debts` namespace.
  const tKey = useTranslations();
  const locale = useLocale();

  const isCreate = mode === "create";

  const form = useForm<DebtFormValues>({
    resolver: (isCreate
      ? zodResolver(createDebtSchema)
      : zodResolver(debtTermsSchema)) as unknown as Resolver<DebtFormValues>,
    defaultValues: {
      accountId: account?.accountId ?? "",
      name: "",
      kind: "liability",
      placement: "personal",
      institution: "",
      amount: "",
      // No date field rides on this form: the owed amount is true as of today.
      balanceOn: todayInBogota(),
      debtKind: "revolving",
      annualRate: "",
      minimumMode: "fixed",
      minimumPayment: null,
      minimumPaymentPct: null,
      creditLimit: null,
      statementCutOffDay: null,
      paymentDueDay: null,
      aval: null,
    },
  });

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary, and neither carries `onSuccess`: the
  // create path chains both actions by hand and only closes once terms land.
  const createAccount = useAction(createAccountAction, {
    onError: onActionError,
  });
  const saveTerms = useAction(saveDebtTermsAction, {
    onError: onActionError,
  });

  const isPending = createAccount.isPending || saveTerms.isPending;

  // Drives which minimum input shows; the toggle nulls the other value so the
  // schema's amount-XOR-percentage check can never fail through this form.
  const minimumMode = useWatch({ control: form.control, name: "minimumMode" });

  function termsInput(values: DebtFormValues, accountId: string): DebtTermsInput {
    return {
      accountId,
      debtKind: values.debtKind,
      annualRate: values.annualRate,
      minimumPayment: values.minimumPayment,
      minimumPaymentPct: values.minimumPaymentPct,
      creditLimit: values.creditLimit,
      statementCutOffDay: values.statementCutOffDay,
      paymentDueDay: values.paymentDueDay,
      aval: values.aval,
    };
  }

  async function onSubmit(values: DebtFormValues) {
    if (isCreate) {
      // Step one: the account. A liability's opening balance is submitted as a
      // positive string in the currency it settles in; the query signs it
      // negative from its kind.
      const created = await createAccount.executeAsync({
        name: values.name,
        kind: "liability",
        // A debt is a card: the only subtype a liability admits (accounts_subtype_kind).
        subtype: "tarjeta",
        placement: values.placement,
        institution: values.institution,
        settlementCurrency: currency,
        amount: values.amount,
        balanceOn: values.balanceOn,
      } satisfies CreateAccountInput);

      const accountId = created?.data?.accountId;
      if (!accountId) return;

      // Step two: its terms. A failure here leaves a bare liability that
      // reappears under "Completar términos"; the account is not rolled back.
      const saved = await saveTerms.executeAsync(termsInput(values, accountId));
      if (!saved?.data) return;
    } else {
      const saved = await saveTerms.executeAsync(
        termsInput(values, values.accountId),
      );
      if (!saved?.data) return;
    }

    toast.success(t("saved"));
    onOpenChange(false);
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        {isCreate ? (
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="debt-name">{t("nameLabel")}</FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="debt-name"
                    size="3"
                    autoFocus
                    autoComplete="off"
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        ) : (
          // The account already exists; its name is fixed and its balance is
          // derived, so both show read-only and terms never write a balance.
          <>
            <Field>
              <FieldLabel>{t("nameLabel")}</FieldLabel>
              <Text size="3">{account?.name}</Text>
            </Field>
            <Field>
              <FieldLabel>{t("openingBalanceLabel")}</FieldLabel>
              <Text size="3">
                {/* JSX cannot travel through `t()`, and this is the same figure
                    `Money` draws, character for character (RF-121). */}
                {formatMoney(Math.abs(account?.owedCents ?? 0), currency, locale)}
              </Text>
            </Field>
          </>
        )}

        {/* The group placement only exists when the caller has a group: without
            one the option would name a home the account cannot land in. */}
        {isCreate && hasGroup && (
          <Controller
            name="placement"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel id="debt-placement-label">
                  {t("placementLabel")}
                </FieldLabel>
                <FieldControl>
                  <SegmentedControl.Root
                    size="3"
                    value={field.value}
                    onValueChange={field.onChange}
                    aria-labelledby="debt-placement-label"
                  >
                    <SegmentedControl.Item value="personal">
                      {t("placementPersonal")}
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="group">
                      {t("placementGroup")}
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {isCreate && (
          <Controller
            name="institution"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="debt-institution">
                  <Flex as="span" align="center" gap="1">
                    {t("institutionLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="debt-institution"
                    size="3"
                    autoComplete="organization"
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {isCreate && (
          <Controller
            name="amount"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="debt-amount">
                  {t("openingBalanceLabel")}
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="debt-amount"
                    size="3"
                    inputMode={amountInputMode(currency)}
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        <Controller
          name="debtKind"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel id="debt-kind-label">{t("kindLabel")}</FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-labelledby="debt-kind-label"
                >
                  <SegmentedControl.Item value="revolving">
                    {t("kindRevolving")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="installment">
                    {t("kindInstallment")}
                  </SegmentedControl.Item>
                </SegmentedControl.Root>
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="annualRate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-rate">{t("annualRateLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="debt-rate"
                  size="3"
                  inputMode="decimal"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* The minimum is a fixed amount XOR a percentage: the toggle nulls the
            value it hides, so only one ever reaches the schema. */}
        <Controller
          name="minimumMode"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel id="debt-minimum-label">
                <Flex as="span" align="center" gap="1">
                  {t("minimumLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    if (value === "fixed") {
                      form.setValue("minimumPaymentPct", null);
                    } else {
                      form.setValue("minimumPayment", null);
                    }
                  }}
                  aria-labelledby="debt-minimum-label"
                >
                  <SegmentedControl.Item value="fixed">
                    {t("minimumFixed")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="pct">
                    {t("minimumPct")}
                  </SegmentedControl.Item>
                </SegmentedControl.Root>
              </FieldControl>
            </Field>
          )}
        />

        {minimumMode === "fixed" ? (
          <Controller
            name="minimumPayment"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="debt-minimum-fixed">
                  {t("minimumFixed")}
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="debt-minimum-fixed"
                    size="3"
                    inputMode={amountInputMode(currency)}
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || null)
                    }
                    onBlur={field.onBlur}
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        ) : (
          <Controller
            name="minimumPaymentPct"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="debt-minimum-pct">
                  {t("minimumPct")}
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="debt-minimum-pct"
                    size="3"
                    inputMode="decimal"
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || null)
                    }
                    onBlur={field.onBlur}
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        <Controller
          name="creditLimit"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-credit-limit">
                <Flex as="span" align="center" gap="1">
                  {t("creditLimitLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="debt-credit-limit"
                  size="3"
                  inputMode={amountInputMode(currency)}
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value || null)}
                  onBlur={field.onBlur}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="statementCutOffDay"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-cut-off-day">
                <Flex as="span" align="center" gap="1">
                  {t("cutOffDayLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="debt-cut-off-day"
                  size="3"
                  inputMode="numeric"
                  value={field.value == null ? "" : String(field.value)}
                  onChange={(event) =>
                    field.onChange(
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                    )
                  }
                  onBlur={field.onBlur}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="paymentDueDay"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-due-day">
                <Flex as="span" align="center" gap="1">
                  {t("dueDayLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="debt-due-day"
                  size="3"
                  inputMode="numeric"
                  value={field.value == null ? "" : String(field.value)}
                  onChange={(event) =>
                    field.onChange(
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                    )
                  }
                  onBlur={field.onBlur}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="aval"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="debt-aval">
                <Flex as="span" align="center" gap="1">
                  {t("avalLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="debt-aval"
                  size="3"
                  inputMode={amountInputMode(currency)}
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value || null)}
                  onBlur={field.onBlur}
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
              {t("save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
