"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { createGoalAction, updateGoalAction } from "@/app/actions/savings-goals";
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
  Select,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { GoalProgress } from "@/db/queries/savings-goals";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
// The field takes the decimals the row's currency is written with, so
// reopening a figure and saving it back stores the integer it already held.
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createGoalSchema,
  refineGoalAmounts,
  updateGoalSchema,
  type CreateGoalInput,
  type UpdateGoalInput,
} from "@/lib/validation/savings-goal";

// Radix's Select rejects an empty-string item value, so "no display account"
// needs its own sentinel; it maps back to null the moment it is picked.
const NONE = "none";

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so `initialContribution` never reaches the
// edit action and `goalId` never reaches the create one.
type GoalFormValues = {
  goalId?: string;
  name: string;
  targetAmount: string;
  targetDate: string | null;
  accountId: string | null;
  initialContribution?: string | null;
};

export function GoalFormDialog({
  open,
  onOpenChange,
  options,
  scopeCurrency,
  goal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: TransactionFormOptions;
  // What a goal naming no account derives: the fund's currency, or the person's
  // own when they hold no fund (RF-121). Read by the server, since a form cannot
  // see either row.
  scopeCurrency: string;
  goal?: GoalProgress;
}) {
  const t = useTranslations("goals");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{goal ? t("editTitle") : t("addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <GoalForm
          key={goal?.id ?? "create"}
          options={options}
          scopeCurrency={scopeCurrency}
          goal={goal}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function GoalForm({
  options,
  scopeCurrency,
  goal,
  onOpenChange,
}: {
  options: TransactionFormOptions;
  scopeCurrency: string;
  goal?: GoalProgress;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("goals");
  // Root-scoped: the keys under `common` sit outside the `goals` namespace.
  const tKey = useTranslations();

  const isEdit = !!goal;

  // The meta and the opening aporte are read in the currency the goal derives:
  // the account's when it names one, the scope's otherwise — the same chain
  // `resolveGoalCurrency` walks for the action (RF-121, RNF-10).
  const resolver: Resolver<GoalFormValues> = (values, context, options_) => {
    const schema = (isEdit ? updateGoalSchema : createGoalSchema).superRefine(
      refineGoalAmounts(
        (values.accountId
          ? options.accountCurrencies[values.accountId]
          : undefined) ?? scopeCurrency,
      ),
    );

    return (zodResolver(schema) as unknown as Resolver<GoalFormValues>)(
      values,
      context,
      options_,
    );
  };

  const form = useForm<GoalFormValues>({
    resolver,
    defaultValues: goal
      ? {
          goalId: goal.id,
          name: goal.name,
          targetAmount: amountToInput(goal.targetAmountCents, goal.currency),
          targetDate: goal.targetDate,
          accountId: goal.accountId,
        }
      : {
          name: "",
          targetAmount: "",
          targetDate: null,
          accountId: null,
          initialContribution: null,
        },
  });

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createGoalAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateGoalAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: GoalFormValues) {
    // The resolver already parsed `values` against the schema for this mode,
    // stripping the field the other mode's action does not accept.
    if (isEdit) {
      update.execute(values as UpdateGoalInput);
    } else {
      create.execute(values as CreateGoalInput);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="goal-name">{t("nameLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="goal-name"
                  size="3"
                  placeholder={t("namePlaceholder")}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="targetAmount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="goal-target">{t("targetLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="goal-target"
                  size="3"
                  inputMode="numeric"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* The target day is a hint, never a due date; an empty picker keeps it
            null so the goal carries no date at all (RF-76). */}
        <Controller
          name="targetDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="goal-date">
                <Flex as="span" align="center" gap="1">
                  {t("targetDateLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="goal-date"
                  size="3"
                  type="date"
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

        {/* The display account only names where the earmarked money notionally
            sits; it fixes the goal's scope and moves nothing (RF-76). */}
        <Controller
          name="accountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="goal-account">
                <Flex as="span" align="center" gap="1">
                  {t("accountLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <Select.Root
                size="3"
                value={field.value ?? NONE}
                onValueChange={(value) =>
                  field.onChange(value === NONE ? null : value)
                }
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="goal-account" />
                </FieldControl>
                <Select.Content position="popper">
                  <Select.Item value={NONE}>{t("accountNone")}</Select.Item>
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

        {/* An opening aporte only exists at creation; an edit changes fields, not
            the earmarked amount, so this stays off the update form (RF-87). */}
        {!isEdit && (
          <Controller
            name="initialContribution"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="goal-initial">
                  <Flex as="span" align="center" gap="1">
                    {t("initialContributionLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="goal-initial"
                    size="3"
                    inputMode="numeric"
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
          <Callout.Text>{t("virtualHint")}</Callout.Text>
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
