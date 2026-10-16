"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { createBudgetAction, updateBudgetAction } from "@/app/actions/budgets";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  SegmentedControl,
  Select,
  Slider,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { BudgetStatus } from "@/db/queries/budgets";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
// The field takes the decimals the row's currency is written with, so
// reopening a figure and saving it back stores the integer it already held.
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  BUDGET_PERIODS,
  createBudgetSchema,
  refineBudgetLimit,
  updateBudgetSchema,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "@/lib/validation/budget";

// Radix's Select rejects an empty-string item value, so "no narrowing" needs its
// own sentinel; it maps back to null the moment it is picked.
const ANY = "none";

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so `categoryId` never reaches the edit action
// and `budgetId` never reaches the create one.
type BudgetFormValues = {
  budgetId?: string;
  categoryId?: string;
  accountId: string | null;
  labelId: string | null;
  period: (typeof BUDGET_PERIODS)[number];
  limit: string;
  thresholdPct: number;
  name: string | null;
};

export function BudgetFormDialog({
  open,
  onOpenChange,
  options,
  scopeCurrency,
  budget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: TransactionFormOptions;
  // What a budget naming no account derives: the fund's currency, or the
  // person's own when they hold no fund (RF-121). Read by the server, since a
  // form cannot see either row.
  scopeCurrency: string;
  budget?: BudgetStatus;
}) {
  const t = useTranslations("budgets");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{budget ? t("editTitle") : t("addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <BudgetForm
          key={budget?.id ?? "create"}
          options={options}
          scopeCurrency={scopeCurrency}
          budget={budget}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function BudgetForm({
  options,
  scopeCurrency,
  budget,
  onOpenChange,
}: {
  options: TransactionFormOptions;
  scopeCurrency: string;
  budget?: BudgetStatus;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("budgets");
  // Root-scoped: the keys under `common` sit outside the `budgets` namespace.
  const tKey = useTranslations();

  const isEdit = !!budget;

  // The limit is measured against an expense category's spend, so only expense
  // categories can carry a budget (RF-71); children are offered alongside their
  // parent so a budget can narrow to a subcategory.
  const expenseCategories = options.categories
    .filter((category) => category.kind === "expense")
    .flatMap((category) => [
      { id: category.id, name: category.name },
      ...category.children.map((child) => ({ id: child.id, name: child.name })),
    ]);
  const categoryName = expenseCategories.find(
    (category) => category.id === budget?.categoryId,
  )?.name;

  // The limit is read in the currency the budget derives: the account's when it
  // names one, the scope's otherwise — the same chain `resolveBudgetCurrency`
  // walks for the action, so the form refuses exactly what the action refuses
  // (RF-121, RNF-10).
  const resolver: Resolver<BudgetFormValues> = (values, context, options_) => {
    const schema = (isEdit ? updateBudgetSchema : createBudgetSchema).superRefine(
      refineBudgetLimit(
        (values.accountId
          ? options.accountCurrencies[values.accountId]
          : undefined) ?? scopeCurrency,
      ),
    );

    return (zodResolver(schema) as unknown as Resolver<BudgetFormValues>)(
      values,
      context,
      options_,
    );
  };

  const form = useForm<BudgetFormValues>({
    resolver,
    defaultValues: budget
      ? {
          budgetId: budget.id,
          accountId: budget.accountId,
          labelId: budget.labelId,
          period: budget.period,
          limit: amountToInput(budget.limitCents, budget.currency),
          thresholdPct: budget.thresholdPct,
          name: budget.name,
        }
      : {
          categoryId: "",
          accountId: null,
          labelId: null,
          period: "monthly",
          limit: "",
          thresholdPct: 80,
          name: null,
        },
  });

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createBudgetAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateBudgetAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  const threshold = useWatch({ control: form.control, name: "thresholdPct" });

  function onSubmit(values: BudgetFormValues) {
    // The resolver already parsed `values` against the schema for this mode,
    // stripping the field the other mode's action does not accept.
    if (isEdit) {
      update.execute(values as UpdateBudgetInput);
    } else {
      create.execute(values as CreateBudgetInput);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        {/* The category fixes the budget's scope, which the trigger checks, so it
            is immutable after creation and read-only on edit (RF-71). */}
        {isEdit ? (
          <Field>
            {/* Not labelable: a read-only Text names nothing a <label> can target. */}
            <FieldLabel>{t("categoryLabel")}</FieldLabel>
            <Text size="3">{categoryName}</Text>
            <FieldDescription>{t("categoryLocked")}</FieldDescription>
          </Field>
        ) : (
          <Controller
            name="categoryId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="budget-category">
                  {t("categoryLabel")}
                </FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger
                      id="budget-category"
                      placeholder={t("categoryPlaceholder")}
                    />
                  </FieldControl>
                  <Select.Content position="popper">
                    {expenseCategories.map((category) => (
                      <Select.Item key={category.id} value={category.id}>
                        {category.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {/* Two budgets on one category tell themselves apart by this name; left
            empty, the card falls back to the category's own (RF-71). */}
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="budget-name">
                <Flex as="span" align="center" gap="1">
                  {t("nameLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="budget-name"
                  size="3"
                  autoComplete="off"
                  disabled={isPending}
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value || null)}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="limit"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="budget-limit">{t("limitLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="budget-limit"
                  size="3"
                  inputMode="numeric"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="period"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel id="budget-period-label">
                {t("periodLabel")}
              </FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-labelledby="budget-period-label"
                >
                  <SegmentedControl.Item value="weekly">
                    {t("periodWeekly")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="monthly">
                    {t("periodMonthly")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="yearly">
                    {t("periodYearly")}
                  </SegmentedControl.Item>
                </SegmentedControl.Root>
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="thresholdPct"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel id="budget-threshold-label">
                {t("thresholdLabel")}
              </FieldLabel>
              <Flex align="center" gap="4">
                <Slider
                  value={[field.value]}
                  onValueChange={([value]) => field.onChange(value)}
                  min={1}
                  max={100}
                  step={1}
                  disabled={isPending}
                  aria-labelledby="budget-threshold-label"
                  style={{ flex: 1 }}
                />
                <Text
                  size="3"
                  weight="bold"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {t("thresholdValue", { pct: threshold })}
                </Text>
              </Flex>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* The account and label only narrow the spend the limit is measured
            against; leaving either off measures the category's whole spend. */}
        <Controller
          name="accountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="budget-account">
                <Flex as="span" align="center" gap="1">
                  {t("accountLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <Select.Root
                size="3"
                value={field.value ?? ANY}
                onValueChange={(value) =>
                  field.onChange(value === ANY ? null : value)
                }
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="budget-account" />
                </FieldControl>
                <Select.Content position="popper">
                  <Select.Item value={ANY}>{t("accountAny")}</Select.Item>
                  {options.accounts.map((account) => (
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

        {options.labels.length > 0 && (
          <Controller
            name="labelId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="budget-label">
                  <Flex as="span" align="center" gap="1">
                    {t("labelLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value ?? ANY}
                  onValueChange={(value) =>
                    field.onChange(value === ANY ? null : value)
                  }
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="budget-label" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={ANY}>{t("labelAny")}</Select.Item>
                    {options.labels.map((label) => (
                      <Select.Item key={label.id} value={label.id}>
                        {label.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
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
              {t("save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
