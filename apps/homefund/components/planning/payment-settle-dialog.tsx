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
  TextField,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import { todayInBogota } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  settlePlannedPaymentSchema,
  type SettlePlannedPaymentInput,
} from "@/lib/validation/planned-payment";

export function PaymentSettleDialog({
  open,
  onOpenChange,
  payment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment?: PlannedPaymentRow;
}) {
  const t = useTranslations("plannedPayments");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("settleTitle")}</Dialog.Title>
        <Dialog.Description>{t("settleDescription")}</Dialog.Description>
        {/* Remounts per payment so the date field is always born at today. */}
        {payment && (
          <SettleForm
            key={payment.id}
            payment={payment}
            onOpenChange={onOpenChange}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SettleForm({
  payment,
  onOpenChange,
}: {
  payment: PlannedPaymentRow;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("plannedPayments");
  const tKey = useTranslations();

  const form = useForm<SettlePlannedPaymentInput>({
    resolver: zodResolver(settlePlannedPaymentSchema),
    defaultValues: {
      plannedPaymentId: payment.id,
      occurredAt: todayInBogota(),
    },
  });

  const onActionError = useActionErrorToast();

  // The reused action records the real movement and flips the payment to done;
  // a payment no longer pending surfaces as `alreadySettled` (RF-75).
  const settle = useAction(settlePlannedPaymentAction, {
    onSuccess() {
      toast.success(t("settled"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  return (
    <form
      onSubmit={form.handleSubmit((values) => settle.execute(values))}
      noValidate
    >
      <FieldGroup>
        <Controller
          name="occurredAt"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="settle-date">{t("occurredAtLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="settle-date"
                  size="3"
                  type="date"
                  disabled={settle.isPending}
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
                disabled={settle.isPending}
              >
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={settle.isPending}>
              {settle.isPending && <Spinner />}
              {t("settle")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
