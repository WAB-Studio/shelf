"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
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
  Spinner,
  DateInput,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import { todayInBogota } from "@/lib/dates";
import { isExpectedIncome } from "@/lib/fund/glance";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  settlePlannedPaymentSchema,
  type SettlePlannedPaymentInput,
} from "@/lib/validation/planned-payment";

/**
 * «Pagar» and «Ya llegó»: books the real movement a pending payment or expected income stood for, on the day
 * the person says it happened (RF-161). The action is the one the old Pagos screen ran.
 */
export function UpcomingSettleDialog({
  open,
  onOpenChange,
  payment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment?: PlannedPaymentRow;
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
          <SettleForm key={payment.id} payment={payment} income={income} onOpenChange={onOpenChange} />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SettleForm({
  payment,
  income,
  onOpenChange,
}: {
  payment: PlannedPaymentRow;
  income: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("upcoming");
  const tKey = useTranslations();

  const form = useForm<SettlePlannedPaymentInput>({
    resolver: zodResolver(settlePlannedPaymentSchema),
    defaultValues: {
      plannedPaymentId: payment.id,
      occurredAt: todayInBogota(),
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
    <form onSubmit={form.handleSubmit((values) => settle.execute(values))} noValidate>
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
