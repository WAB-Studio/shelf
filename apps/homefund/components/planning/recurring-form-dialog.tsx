"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import {
  createRecurringRuleAction,
  updateRecurringRuleAction,
} from "@/app/actions/recurring-rules";
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
  SegmentedControl,
  Select,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { isCivilDate } from "@/lib/dates";
// The field takes the decimals the row's currency is written with, so
// reopening a figure and saving it back stores the integer it already held.
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createRecurringRuleSchema,
  refineRuleAmount,
  updateRecurringRuleSchema,
  type CreateRecurringRuleInput,
  type UpdateRecurringRuleInput,
} from "@/lib/validation/recurring-rule";

// Radix's Select rejects an empty-string item value, so "no category" needs its
// own sentinel; it maps back to "" so the shared uuid schema flags the gap.
const NO_CATEGORY = "none";

// A superset of both schemas' shapes plus the two form-only helpers: `direction`
// splits the one account onto the source or destination slot, and the resolver
// strips whichever key the active schema does not declare.
type RuleFormValues = {
  id?: string;
  direction: "income" | "expense";
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  categoryId: string;
  description: string | null;
  frequency: "monthly" | "weekly" | "yearly";
  intervalN: number;
  dayOfMonth: number | null;
  nextRunOn: string;
  endsOn: string | null;
};

// Yearly anchors its day to the month-day of the next run, so the hidden field
// stays in step with the date the person picks.
function dayFromNextRun(value: string): number | null {
  if (!isCivilDate(value)) return null;
  return Number(value.slice(8, 10));
}

export function RecurringFormDialog({
  open,
  onOpenChange,
  options,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: TransactionFormOptions;
  rule?: RecurringRuleRow;
}) {
  const t = useTranslations("recurringRules");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{rule ? t("editTitle") : t("addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <RecurringForm
          key={rule?.id ?? "create"}
          options={options}
          rule={rule}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function RecurringForm({
  options,
  rule,
  onOpenChange,
}: {
  options: TransactionFormOptions;
  rule?: RecurringRuleRow;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("recurringRules");
  // Root-scoped: the keys under `common` sit outside the `recurringRules` namespace.
  const tKey = useTranslations();

  const isEdit = !!rule;

  // A rule names exactly one account, and the values under validation name it:
  // the resolver reads what it settles in off the map the options already carry
  // and refines the mode's own schema with it, so the form refuses exactly what
  // the action refuses against the currency it reads back (RF-121, RNF-10).
  const resolver: Resolver<RuleFormValues> = (values, context, options_) => {
    const schema = (
      isEdit ? updateRecurringRuleSchema : createRecurringRuleSchema
    ).superRefine(
      refineRuleAmount({
        from: values.fromAccountId
          ? options.accountCurrencies[values.fromAccountId] ?? null
          : null,
        to: values.toAccountId
          ? options.accountCurrencies[values.toAccountId] ?? null
          : null,
      }),
    );

    return (zodResolver(schema) as unknown as Resolver<RuleFormValues>)(
      values,
      context,
      options_,
    );
  };

  const form = useForm<RuleFormValues>({
    resolver,
    defaultValues: rule
      ? {
          id: rule.id,
          direction: rule.toAccountId !== null ? "income" : "expense",
          fromAccountId: rule.fromAccountId,
          toAccountId: rule.toAccountId,
          amount: amountToInput(rule.amountCents, rule.currency),
          categoryId: rule.categoryId,
          description: rule.description,
          frequency: rule.frequency,
          intervalN: rule.intervalN,
          dayOfMonth: rule.dayOfMonth,
          nextRunOn: rule.nextRunOn,
          endsOn: rule.endsOn,
        }
      : {
          direction: "expense",
          fromAccountId: null,
          toAccountId: null,
          amount: "",
          categoryId: "",
          description: null,
          frequency: "monthly",
          intervalN: 1,
          dayOfMonth: null,
          nextRunOn: "",
          endsOn: null,
        },
  });

  const direction = useWatch({ control: form.control, name: "direction" });
  const fromAccountId = useWatch({
    control: form.control,
    name: "fromAccountId",
  });
  const toAccountId = useWatch({ control: form.control, name: "toAccountId" });
  const frequency = useWatch({ control: form.control, name: "frequency" });
  const nextRunOn = useWatch({ control: form.control, name: "nextRunOn" });

  const accountId = direction === "income" ? toAccountId : fromAccountId;

  // The one account fixes the rule's scope (RF-62): a personal account names its
  // owner's set, a group account the group's.
  const scope = useMemo(() => {
    const account = options.accounts.find((one) => one.id === accountId);
    return account?.groupId ? "group" : "personal";
  }, [options.accounts, accountId]);

  // Only that scope's categories, and only of the direction's kind (RF-27),
  // parents and children flattened into one pickable list: anything else is what
  // the scope trigger refuses on write.
  const categories = useMemo(
    () =>
      options.categories
        .filter(
          (category) => category.scope === scope && category.kind === direction,
        )
        .flatMap((category) => [
          { id: category.id, name: category.name },
          ...category.children.map((child) => ({
            id: child.id,
            name: child.name,
          })),
        ]),
    [options.categories, scope, direction],
  );

  // Switching direction or moving to an account of the other scope strands the
  // category outside that list, so the selection drops.
  useEffect(() => {
    const categoryId = form.getValues("categoryId");
    if (categoryId && !categories.some((one) => one.id === categoryId)) {
      form.setValue("categoryId", "", { shouldValidate: true });
    }
  }, [categories, form]);

  // Weekly carries no day anchor; yearly tracks the next run's day; monthly keeps
  // the person's day, seeding it from the next run only while it is still empty.
  useEffect(() => {
    if (frequency === "weekly") {
      if (form.getValues("dayOfMonth") !== null) form.setValue("dayOfMonth", null);
    } else if (frequency === "yearly") {
      form.setValue("dayOfMonth", dayFromNextRun(nextRunOn));
    } else if (form.getValues("dayOfMonth") == null) {
      form.setValue("dayOfMonth", dayFromNextRun(nextRunOn));
    }
  }, [frequency, nextRunOn, form]);

  function setDirection(value: "income" | "expense") {
    if (value === "income") {
      form.setValue("toAccountId", accountId, { shouldValidate: true });
      form.setValue("fromAccountId", null);
    } else {
      form.setValue("fromAccountId", accountId, { shouldValidate: true });
      form.setValue("toAccountId", null);
    }
    form.setValue("direction", value);
  }

  function setAccount(value: string | null) {
    if (direction === "income") {
      form.setValue("toAccountId", value, { shouldValidate: true });
      form.setValue("fromAccountId", null);
    } else {
      form.setValue("fromAccountId", value, { shouldValidate: true });
      form.setValue("toAccountId", null);
    }
  }

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createRecurringRuleAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateRecurringRuleAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: RuleFormValues) {
    // The resolver already parsed `values` against the schema for this mode; the
    // server re-validates and strips the form-only `direction` helper.
    if (isEdit) {
      update.execute(values as unknown as UpdateRecurringRuleInput);
    } else {
      create.execute(values as unknown as CreateRecurringRuleInput);
    }
  }

  const accountError =
    form.formState.errors.fromAccountId ?? form.formState.errors.toAccountId;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="rule-concept">{t("conceptLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="rule-concept"
                  size="3"
                  placeholder={t("conceptPlaceholder")}
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
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="rule-amount">{t("amountLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="rule-amount"
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
          name="nextRunOn"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="rule-next">{t("nextRunLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="rule-next"
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
          name="frequency"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel id="rule-frequency-label">
                {t("frequencyLabel")}
              </FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-labelledby="rule-frequency-label"
                >
                  <SegmentedControl.Item value="weekly">
                    {t("frequencyWeekly")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="monthly">
                    {t("frequencyMonthly")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="yearly">
                    {t("frequencyYearly")}
                  </SegmentedControl.Item>
                </SegmentedControl.Root>
              </FieldControl>
            </Field>
          )}
        />

        <Controller
          name="intervalN"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="rule-interval">
                {t("intervalLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="rule-interval"
                  size="3"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  disabled={isPending}
                  value={Number.isNaN(field.value) ? "" : String(field.value)}
                  onChange={(event) => field.onChange(Number(event.target.value))}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* Monthly anchors a day of the month; weekly advances from the next run
            and yearly derives its day from that date, so neither shows the input. */}
        {frequency === "monthly" && (
          <Controller
            name="dayOfMonth"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="rule-day">{t("dayOfMonthLabel")}</FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="rule-day"
                    size="3"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={31}
                    disabled={isPending}
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
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        <Field>
          <FieldLabel id="rule-direction-label">
            {t("directionLabel")}
          </FieldLabel>
          <FieldControl>
            <SegmentedControl.Root
              size="3"
              value={direction}
              onValueChange={(value) =>
                setDirection(value as "income" | "expense")
              }
              aria-labelledby="rule-direction-label"
            >
              <SegmentedControl.Item value="expense">
                {t("directionExpense")}
              </SegmentedControl.Item>
              <SegmentedControl.Item value="income">
                {t("directionIncome")}
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </FieldControl>
        </Field>

        {/* One account fixes the rule's scope and direction (RF-29); its slot
            follows the toggle above. */}
        <Field invalid={!!accountError}>
          <FieldLabel htmlFor="rule-account">{t("accountLabel")}</FieldLabel>
          <Select.Root
            size="3"
            value={accountId ?? NO_CATEGORY}
            onValueChange={(value) =>
              setAccount(value === NO_CATEGORY ? null : value)
            }
            disabled={isPending}
          >
            <FieldControl>
              <Select.Trigger id="rule-account" />
            </FieldControl>
            <Select.Content position="popper">
              <Select.Item value={NO_CATEGORY}>{t("accountNone")}</Select.Item>
              {options.accounts.map((account) => (
                <Select.Item key={account.id} value={account.id}>
                  {account.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <FieldMessage error={accountError} />
        </Field>

        <Controller
          name="categoryId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="rule-category">
                {t("categoryLabel")}
              </FieldLabel>
              <Select.Root
                size="3"
                value={field.value || NO_CATEGORY}
                onValueChange={(value) =>
                  field.onChange(value === NO_CATEGORY ? "" : value)
                }
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="rule-category" />
                </FieldControl>
                <Select.Content position="popper">
                  <Select.Item value={NO_CATEGORY}>
                    {t("categoryNone")}
                  </Select.Item>
                  {categories.map((category) => (
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

        {/* The end date bounds when the rule stops generating (RF-32); it only
            opens once the rule exists to be capped. */}
        {isEdit && (
          <Controller
            name="endsOn"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="rule-ends">
                  <Flex as="span" align="center" gap="1">
                    {t("endsOnLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="rule-ends"
                    size="3"
                    type="date"
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

        <Callout.Root color="jade" variant="soft">
          <Callout.Icon>
            <Info size={16} aria-hidden />
          </Callout.Icon>
          <Callout.Text>{t("autoHint")}</Callout.Text>
        </Callout.Root>

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
