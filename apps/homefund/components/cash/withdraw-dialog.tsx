"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BanknoteArrowDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { withdrawCashAction } from "@/app/actions/cash";
import {
  Button,
  Callout,
  Card,
  CategoryTile,
  Dialog,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  withdrawCashSchema,
  type WithdrawCashInput,
} from "@/lib/validation/cash";

/**
 * The dashboard's cash affordance beside quick entry (RF-68): a card that raises
 * the withdrawal dialog in place. The destination is the caller's cash, resolved
 * server-side from `cash_mode` and shown read-only; only the source and the
 * amount are chosen. With no cash yet, submitting creates it on the way in (RF-56).
 */
export function WithdrawCashCard({
  sources,
  destinationName,
  willCreate,
}: {
  sources: AccountRow[];
  destinationName: string;
  willCreate: boolean;
}) {
  const t = useTranslations("cash");
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Card asChild>
          <button
            type="button"
            style={{ width: "100%", textAlign: "start", font: "inherit", cursor: "pointer" }}
          >
            <Flex align="center" gap="3">
              <CategoryTile
                color="var(--accent-3)"
                size={34}
                icon={
                  <BanknoteArrowDown size={19} strokeWidth={2.2} color="var(--accent-11)" />
                }
              />
              <Text size="3" weight="medium">
                {t("withdrawAction")}
              </Text>
            </Flex>
          </button>
        </Card>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>{t("withdrawTitle")}</Dialog.Title>
        {/* Closing unmounts the content, so the form is born fresh each open. */}
        <WithdrawForm
          sources={sources}
          destinationName={destinationName}
          willCreate={willCreate}
          onOpenChange={setOpen}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function WithdrawForm({
  sources,
  destinationName,
  willCreate,
  onOpenChange,
}: {
  sources: AccountRow[];
  destinationName: string;
  willCreate: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("cash");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();

  const form = useForm<WithdrawCashInput>({
    resolver: zodResolver(withdrawCashSchema),
    mode: "onChange",
    defaultValues: {
      sourceAccountId: sources[0]?.id ?? "",
      amount: "",
    },
  });

  const withdraw = useAction(withdrawCashAction, {
    onSuccess() {
      toast.success(t("withdrawSaved"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  function onSubmit(values: WithdrawCashInput) {
    withdraw.execute(values);
  }

  // Nothing to draw from: cash can only come out of an asset account (RF-40), so
  // without one the dialog guides instead of offering an unusable form.
  if (sources.length === 0) {
    return (
      <Flex direction="column" gap="4">
        <Callout.Root color="amber" variant="soft">
          <Callout.Text>{t("noSource")}</Callout.Text>
        </Callout.Root>
        <Flex justify="end">
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray">
              {tKey("common.cancel")}
            </Button>
          </Dialog.Close>
        </Flex>
      </Flex>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="sourceAccountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="withdraw-source">{t("sourceLabel")}</FieldLabel>
              <Select.Root
                size="3"
                value={field.value || undefined}
                onValueChange={field.onChange}
                disabled={withdraw.isPending}
              >
                <FieldControl>
                  <Select.Trigger id="withdraw-source" placeholder={t("sourceLabel")} />
                </FieldControl>
                <Select.Content position="popper">
                  {sources.map((account) => (
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
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="withdraw-amount">{t("amountLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="withdraw-amount"
                  size="3"
                  inputMode="numeric"
                  autoFocus
                  disabled={withdraw.isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {/* The destination is fixed, never a control: it is the caller's cash the
            `cash_mode` points at (RF-68). */}
        <Field>
          <FieldLabel>{t("destinationLabel")}</FieldLabel>
          <Text size="3">{destinationName}</Text>
          {willCreate && <FieldDescription>{t("willCreateHint")}</FieldDescription>}
        </Field>

        <Flex gap="3" justify="end">
          <Dialog.Close>
            <Button
              type="button"
              variant="soft"
              color="gray"
              disabled={withdraw.isPending}
            >
              {tKey("common.cancel")}
            </Button>
          </Dialog.Close>
          <Button
            type="submit"
            disabled={!form.formState.isValid || withdraw.isPending}
          >
            {withdraw.isPending && <Spinner />}
            {t("withdrawSave")}
          </Button>
        </Flex>
      </FieldGroup>
    </form>
  );
}
