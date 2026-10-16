"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import {
  createPlannedPaymentAction,
  updatePlannedPaymentAction,
} from "@/app/actions/planned-payments";
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
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
// The field takes the decimals the row's currency is written with, so
// reopening a figure and saving it back stores the integer it already held.
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createPlannedPaymentSchema,
  refinePaymentAmount,
  updatePlannedPaymentSchema,
  type CreatePlannedPaymentInput,
  type UpdatePlannedPaymentInput,
} from "@/lib/validation/planned-payment";

// Radix's Select rejects an empty-string item value, so "no account" and "no
// category" each need their own sentinel; both map back to null when picked.
const NO_ACCOUNT = "none";
const NO_CATEGORY = "none";

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so `plannedPaymentId` never reaches the
// create action.
type PaymentFormValues = {
  plannedPaymentId?: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  categoryId: string | null;
  dueDate: string;
  remindOn: string | null;
  description: string | null;
};

export function PaymentFormDialog({
  open,
  onOpenChange,
  options,
  payment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: TransactionFormOptions;
  payment?: PlannedPaymentRow;
}) {
  const t = useTranslations("plannedPayments");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{payment ? t("editTitle") : t("addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <PaymentForm
          key={payment?.id ?? "create"}
          options={options}
          payment={payment}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function PaymentForm({
  options,
  payment,
  onOpenChange,
}: {
  options: TransactionFormOptions;
  payment?: PlannedPaymentRow;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("plannedPayments");
  // Root-scoped: the keys under `common` sit outside the `plannedPayments` namespace.
  const tKey = useTranslations();

  const isEdit = !!payment;

  // The amount is read in the currency the named accounts settle in, and the
  // values under validation name them: the resolver reads the pair off the map
  // the options already carry and refines the mode's own schema with it, so the
  // form refuses exactly what the action refuses against the currencies it reads
  // back (RF-121, RNF-10).
  const resolver: Resolver<PaymentFormValues> = (values, context, options_) => {
    const schema = (
      isEdit ? updatePlannedPaymentSchema : createPlannedPaymentSchema
    ).superRefine(
      refinePaymentAmount({
        from: values.fromAccountId
          ? options.accountCurrencies[values.fromAccountId] ?? null
          : null,
        to: values.toAccountId
          ? options.accountCurrencies[values.toAccountId] ?? null
          : null,
      }),
    );

    return (zodResolver(schema) as unknown as Resolver<PaymentFormValues>)(
      values,
      context,
      options_,
    );
  };

  const form = useForm<PaymentFormValues>({
    resolver,
    defaultValues: payment
      ? {
          plannedPaymentId: payment.id,
          fromAccountId: payment.fromAccountId,
          toAccountId: payment.toAccountId,
          amount: amountToInput(payment.amountCents, payment.currency),
          categoryId: payment.categoryId,
          dueDate: payment.dueDate,
          remindOn: payment.remindOn,
          description: payment.description,
        }
      : {
          fromAccountId: null,
          toAccountId: null,
          amount: "",
          categoryId: null,
          dueDate: "",
          remindOn: null,
          description: null,
        },
  });

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createPlannedPaymentAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updatePlannedPaymentAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: PaymentFormValues) {
    // The resolver already parsed `values` against the schema for this mode,
    // stripping the field the other mode's action does not accept.
    if (isEdit) {
      update.execute(values as UpdatePlannedPaymentInput);
    } else {
      create.execute(values as CreatePlannedPaymentInput);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="payment-concept">
                {t("conceptLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="payment-concept"
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
              <FieldLabel htmlFor="payment-amount">{t("amountLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="payment-amount"
                  size="3"
                  inputMode="numeric"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* The source and destination the settled movement carries; whichever
            slot is set fixes the payment's scope (RF-74). */}
        <Controller
          name="fromAccountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="payment-from">{t("fromLabel")}</FieldLabel>
              <Select.Root
                size="3"
                value={field.value ?? NO_ACCOUNT}
                onValueChange={(value) =>
                  field.onChange(value === NO_ACCOUNT ? null : value)
                }
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="payment-from" />
                </FieldControl>
                <Select.Content position="popper">
                  <Select.Item value={NO_ACCOUNT}>{t("accountNone")}</Select.Item>
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

        <Controller
          name="toAccountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="payment-to">{t("toLabel")}</FieldLabel>
              <Select.Root
                size="3"
                value={field.value ?? NO_ACCOUNT}
                onValueChange={(value) =>
                  field.onChange(value === NO_ACCOUNT ? null : value)
                }
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="payment-to" />
                </FieldControl>
                <Select.Content position="popper">
                  <Select.Item value={NO_ACCOUNT}>{t("accountNone")}</Select.Item>
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

        <Controller
          name="dueDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="payment-due">{t("dueLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="payment-due"
                  size="3"
                  type="date"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* Optional: the day to be reminded, never after the due date (RF-74). */}
        <Controller
          name="remindOn"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="payment-remind">
                <Flex as="span" align="center" gap="1">
                  {t("remindLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="payment-remind"
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

        {/* Optional: the category the settled movement earmarks (RF-75). */}
        <Controller
          name="categoryId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="payment-category">
                <Flex as="span" align="center" gap="1">
                  {t("categoryLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <Select.Root
                size="3"
                value={field.value ?? NO_CATEGORY}
                onValueChange={(value) =>
                  field.onChange(value === NO_CATEGORY ? null : value)
                }
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="payment-category" />
                </FieldControl>
                <Select.Content position="popper">
                  <Select.Item value={NO_CATEGORY}>
                    {t("categoryNone")}
                  </Select.Item>
                  {options.categories.map((category) => (
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

        <Callout.Root color="jade" variant="soft">
          <Callout.Icon>
            <Info size={16} aria-hidden />
          </Callout.Icon>
          <Callout.Text>{t("reminderHint")}</Callout.Text>
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
