"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BanknoteArrowDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { withdrawCashAction } from "@/app/actions/cash";
import {
  Button,
  Callout,
  CategoryTile,
  Field,
  FieldControl,
  FieldDescription,
  FieldLabel,
  FieldMessage,
  Flex,
  Heading,
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
 * The third card of the desktop dashboard's top row (RF-68): the withdrawal in
 * place, with no dialog between the person and the move. The card's own surface
 * is the summary's, so this draws only its contents. It runs `withdrawCashAction`
 * behind `withdrawCashSchema`, the same pair the phone's dialog submits through,
 * so the server rejects exactly what this rejects (RNF-10).
 *
 * The destination is never a control: it is the account `resolveWithdrawalTarget`
 * named from the group's `cash_mode`, shown read-only, and created on the way in
 * when the caller has none yet (RF-56). Only the origin — an asset account, per
 * RF-40 — and the amount are chosen here.
 */
export function WithdrawPanel({
  sources,
  destinationName,
  willCreate,
}: {
  sources: AccountRow[];
  destinationName: string;
  willCreate: boolean;
}) {
  const t = useTranslations("cash");
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
      // The panel stays open for the next withdrawal; only the amount is cleared.
      form.reset({ sourceAccountId: form.getValues("sourceAccountId"), amount: "" });
    },
    onError: onActionError,
  });

  function onSubmit(values: WithdrawCashInput) {
    withdraw.execute(values);
  }

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="3">
        <CategoryTile
          color="var(--accent-3)"
          size={34}
          icon={
            <BanknoteArrowDown size={17} strokeWidth={1.8} color="var(--accent-11)" />
          }
        />
        <Heading as="h2" size="3">
          {t("withdrawTitle")}
        </Heading>
      </Flex>

      {/* Cash can only come out of an asset account (RF-40), so without one the
          panel guides instead of offering an unusable form. */}
      {sources.length === 0 ? (
        <Callout.Root color="amber" variant="soft">
          <Callout.Text>{t("noSource")}</Callout.Text>
        </Callout.Root>
      ) : (
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <Flex direction="column" gap="3">
            <Controller
              name="sourceAccountId"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="withdraw-panel-source">
                    {t("sourceLabel")}
                  </FieldLabel>
                  <Select.Root
                    value={field.value || undefined}
                    onValueChange={field.onChange}
                    disabled={withdraw.isPending}
                  >
                    <FieldControl>
                      <Select.Trigger
                        id="withdraw-panel-source"
                        placeholder={t("sourceLabel")}
                      />
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
                  <FieldLabel htmlFor="withdraw-panel-amount">
                    {t("amountLabel")}
                  </FieldLabel>
                  <FieldControl>
                    <TextField.Root
                      {...field}
                      id="withdraw-panel-amount"
                      inputMode="numeric"
                      disabled={withdraw.isPending}
                    />
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />

            <Field>
              <FieldLabel>{t("destinationLabel")}</FieldLabel>
              <Text size="2" weight="medium">
                {destinationName}
              </Text>
              {willCreate && <FieldDescription>{t("willCreateHint")}</FieldDescription>}
            </Field>

            <Button
              type="submit"
              disabled={!form.formState.isValid || withdraw.isPending}
            >
              {withdraw.isPending && <Spinner />}
              {t("withdrawSave")}
            </Button>
          </Flex>
        </form>
      )}
    </Flex>
  );
}
