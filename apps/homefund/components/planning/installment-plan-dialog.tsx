"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { createInstallmentPlanAction } from "@/app/actions/installment-plans";
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
} from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createInstallmentPlanSchema,
  INSTALLMENT_FREQUENCIES,
  type CreateInstallmentPlanInput,
} from "@/lib/validation/installment-plan";

// The liability the plan schedules. It is fixed by the caller and never chosen
// here: the scope comes from the account through RLS (RF-81).
export type InstallmentPlanAccount = { id: string; name: string };

// A currency with decimals needs the keypad that types one (RF-121).
function amountInputMode(currency: CurrencyCode): "decimal" | "numeric" {
  return minorUnitExponent(currency) > 0 ? "decimal" : "numeric";
}

const FREQUENCY_LABEL = {
  monthly: "frequencyMonthly",
  fortnightly: "frequencyFortnightly",
} as const;

// The count is typed, so it passes through the form as the empty field a person
// starts from; the schema names the number 1..120 that is missing.
type PlanFormValues = Omit<CreateInstallmentPlanInput, "nInstallments"> & {
  nInstallments: number | null;
};

export function InstallmentPlanDialog({
  open,
  onOpenChange,
  account,
  currency = BASE_CURRENCY,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: InstallmentPlanAccount;
  // The currency the debt settles in: a plan schedules that balance, so its
  // amounts are typed in that currency's minor unit (RF-121). A caller that
  // names none is on an account that settles in the base currency.
  currency?: CurrencyCode;
}) {
  const t = useTranslations("installments");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("planTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            debt, so the form below is always born with fresh defaults. */}
        <PlanForm
          key={account.id}
          account={account}
          currency={currency}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function PlanForm({
  account,
  currency,
  onOpenChange,
}: {
  account: InstallmentPlanAccount;
  currency: CurrencyCode;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("installments");
  // Root-scoped: the keys under `common` and `debts` sit outside this namespace.
  const tKey = useTranslations();

  const form = useForm<PlanFormValues>({
    resolver: zodResolver(
      createInstallmentPlanSchema,
    ) as unknown as Resolver<PlanFormValues>,
    defaultValues: {
      accountId: account.id,
      description: null,
      principal: "",
      nInstallments: null,
      frequency: "monthly",
      interestRate: null,
      downPayment: null,
      aval: null,
      // A plan may start ahead of today; today is only where the picker opens.
      startDate: todayInBogota(),
      merchant: null,
    },
  });

  const onActionError = useActionErrorToast();

  // The dated lines are derived server-side from principal, aval and frequency,
  // so only the terms a person types cross (RF-81).
  const create = useAction(createInstallmentPlanAction, {
    onSuccess() {
      toast.success(t("planSaved"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  const isPending = create.isPending;

  return (
    <form
      onSubmit={form.handleSubmit((values) =>
        create.execute(values as CreateInstallmentPlanInput),
      )}
      noValidate
    >
      <FieldGroup>
        {/* The debt is the caller's; it reads back so the plan names what it
            lands on, and no picker can aim it elsewhere. */}
        <Field>
          <FieldLabel>{tKey("debts.nameLabel")}</FieldLabel>
          <Text size="3">{account.name}</Text>
        </Field>

        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-description">
                <Flex as="span" align="center" gap="1">
                  {t("descriptionLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="plan-description"
                  size="3"
                  autoFocus
                  autoComplete="off"
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

        <Controller
          name="principal"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-principal">
                {t("principalLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="plan-principal"
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
          name="nInstallments"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-installments">
                {t("installmentsLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="plan-installments"
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
          name="frequency"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel id="plan-frequency-label">
                {t("frequencyLabel")}
              </FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-labelledby="plan-frequency-label"
                >
                  {INSTALLMENT_FREQUENCIES.map((frequency) => (
                    <SegmentedControl.Item key={frequency} value={frequency}>
                      {t(FREQUENCY_LABEL[frequency])}
                    </SegmentedControl.Item>
                  ))}
                </SegmentedControl.Root>
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* Annual, the same unit as the debt's own terms rate, so a plan's rate
            and the card's compare without conversion (RF-78, RF-81). */}
        <Controller
          name="interestRate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-rate">
                <Flex as="span" align="center" gap="1">
                  {t("rateLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="plan-rate"
                  size="3"
                  inputMode="decimal"
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

        <Controller
          name="downPayment"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-down-payment">
                <Flex as="span" align="center" gap="1">
                  {t("downPaymentLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="plan-down-payment"
                  size="3"
                  inputMode={amountInputMode(currency)}
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

        <Controller
          name="aval"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-aval">
                <Flex as="span" align="center" gap="1">
                  {t("avalLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="plan-aval"
                  size="3"
                  inputMode={amountInputMode(currency)}
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

        <Controller
          name="startDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-start">{t("startDateLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="plan-start"
                  size="3"
                  type="date"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="merchant"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-merchant">
                <Flex as="span" align="center" gap="1">
                  {t("merchantLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="plan-merchant"
                  size="3"
                  autoComplete="off"
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
              {t("planSave")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
