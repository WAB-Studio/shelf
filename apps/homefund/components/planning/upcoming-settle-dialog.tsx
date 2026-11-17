"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { settlePlannedPaymentAction } from "@/app/actions/planned-payments";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
  DateInput,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { todayInBogota } from "@/lib/dates";
import { scopeOfAccounts } from "@/lib/fund/category-scope";
import { isExpectedIncome } from "@/lib/fund/glance";
import { pickableCategories } from "@/lib/fund/upcoming";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  settlePlannedPaymentSchema,
  type SettlePlannedPaymentInput,
} from "@/lib/validation/planned-payment";

/**
 * «Pagar» and «Ya llegó»: books the real movement a pending payment or expected income stood for, on the day
 * the person says it happened (RF-161). One that carries no category asks for it, since an income or an expense
 * is never booked without one.
 */
export function UpcomingSettleDialog({
  open,
  onOpenChange,
  payment,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment?: PlannedPaymentRow;
  options: TransactionFormOptions;
}) {
  const t = useTranslations("upcoming.settle");
  const income = payment ? isExpectedIncome(payment) : false;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t(income ? "incomeTitle" : "payTitle")}</Dialog.Title>
        <Dialog.Description>{t("description")}</Dialog.Description>
        {/* Remounts per payment so the date field is always born at today. */}
        {payment && (
          <SettleForm key={payment.id} payment={payment} income={income} options={options} onOpenChange={onOpenChange} />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SettleForm({
  payment,
  income,
  options,
  onOpenChange,
}: {
  payment: PlannedPaymentRow;
  income: boolean;
  options: TransactionFormOptions;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("upcoming");
  const tKey = useTranslations();
  const mark = useCallback((name: string) => tKey("categories.scopedName", { name }), [tKey]);

  // A payment between the person's own accounts carries none; any other one without it is asked for here.
  const asksCategory =
    payment.categoryId === null && !(payment.fromAccountId !== null && payment.toAccountId !== null);
  const categories = useMemo(
    () =>
      pickableCategories(
        options.categories,
        scopeOfAccounts([payment.fromAccountId, payment.toAccountId], options.accounts),
        income ? "income" : "expense",
        mark,
      ),
    [options.categories, options.accounts, payment.fromAccountId, payment.toAccountId, income, mark],
  );

  const form = useForm<SettlePlannedPaymentInput>({
    resolver: zodResolver(settlePlannedPaymentSchema),
    defaultValues: {
      plannedPaymentId: payment.id,
      occurredAt: todayInBogota(),
      categoryId: null,
    },
  });

  const onActionError = useActionErrorToast();

  const settle = useAction(settlePlannedPaymentAction, {
    onSuccess() {
      toast.success(t(income ? "settle.arrived" : "settle.paid"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  return (
    <form
      onSubmit={form.handleSubmit((values) => {
        if (asksCategory && !values.categoryId) {
          form.setError("categoryId", { message: "plannedPayments.errors.settleNeedsCategory" });
          return;
        }
        settle.execute(values);
      })}
      noValidate
    >
      <FieldGroup>
        <Controller
          name="occurredAt"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="settle-date">{t("settle.dateLabel")}</FieldLabel>
              <FieldControl>
                <DateInput {...field} id="settle-date" size="3" disabled={settle.isPending} />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {asksCategory && (
          <Controller
            name="categoryId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="settle-category">{t("settle.categoryLabel")}</FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value ?? ""}
                  onValueChange={(value) => field.onChange(value)}
                  disabled={settle.isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="settle-category" placeholder={t("settle.categoryPlaceholder")} />
                  </FieldControl>
                  <Select.Content position="popper">
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
        )}

        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" disabled={settle.isPending}>
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={settle.isPending}>
              {settle.isPending && <Spinner />}
              {t(income ? "act.arrived" : "act.pay")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
