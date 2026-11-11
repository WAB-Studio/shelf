"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { recordMemberDebtAction } from "@/app/actions/member-debts";
import {
  AmountField,
  Button,
  DateInput,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
  TextField,
} from "@/components/ui";
import { BASE_CURRENCY, minorUnitExponent, OFFERED_CURRENCIES, type OfferedCurrency } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  recordMemberDebtSchema,
  type RecordMemberDebtFields,
  type RecordMemberDebtInput,
} from "@/lib/validation/member-debt";

type Member = { id: string; name: string };

// What the button that opened the form fixes. A pair's card names both members, who may since be archived.
export type MemberDebtDraft = {
  kind: "debt" | "payment";
  debtor?: Member;
  creditor?: Member;
  currency?: OfferedCurrency;
};

/** «Registrar deuda» and «Registrar pago» (RF-183): one form, the kind fixed by the button that opened it. */
export function MemberDebtDialog({
  draft,
  members,
  onOpenChange,
}: {
  draft: MemberDebtDraft | null;
  members: Member[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("memberDebts");
  // The last draft stays drawn while the dialog animates out, so its title and form do not flash.
  const [shown, setShown] = useState(draft);
  if (draft !== null && draft !== shown) setShown(draft);

  return (
    <Dialog.Root open={draft !== null} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{shown?.kind === "payment" ? t("recordPayment") : t("recordDebt")}</Dialog.Title>
        {shown && <MemberDebtForm key={JSON.stringify(shown)} draft={shown} members={members} onOpenChange={onOpenChange} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function MemberDebtForm({
  draft,
  members,
  onOpenChange,
}: {
  draft: MemberDebtDraft;
  members: Member[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("memberDebts");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();

  const form = useForm<RecordMemberDebtFields, unknown, RecordMemberDebtInput>({
    resolver: zodResolver(recordMemberDebtSchema),
    defaultValues: {
      kind: draft.kind,
      debtorMemberId: draft.debtor?.id ?? "",
      creditorMemberId: draft.creditor?.id ?? "",
      amount: "",
      currency: draft.currency ?? BASE_CURRENCY,
      occurredOn: todayInBogota(),
      description: "",
    },
  });

  const record = useAction(recordMemberDebtAction, {
    onSuccess() {
      toast.success(draft.kind === "payment" ? t("paymentRecorded") : t("debtRecorded"));
      onOpenChange(false);
    },
    onError: onActionError,
  });
  const isPending = record.isPending;
  const options = [draft.debtor, draft.creditor].reduce(
    (list, member) => (member && !list.some((m) => m.id === member.id) ? [...list, member] : list),
    members,
  );
  const currency = useWatch({ control: form.control, name: "currency" }) ?? BASE_CURRENCY;

  const memberSelect = (name: "debtorMemberId" | "creditorMemberId", label: string) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`member-debt-${name}`}>{label}</FieldLabel>
          <Select.Root size="3" value={field.value || undefined} onValueChange={field.onChange} disabled={isPending}>
            <FieldControl>
              <Select.Trigger id={`member-debt-${name}`} placeholder={label} />
            </FieldControl>
            <Select.Content position="popper">
              {options.map((member) => (
                <Select.Item key={member.id} value={member.id}>
                  {member.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <FieldMessage error={fieldState.error} />
        </Field>
      )}
    />
  );

  return (
    <form onSubmit={form.handleSubmit(() => record.execute(form.getValues()))} noValidate>
      <FieldGroup>
        {memberSelect("debtorMemberId", t("debtorLabel"))}
        {memberSelect("creditorMemberId", t("creditorLabel"))}

        <Flex gap="3">
          <Controller
            name="amount"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="member-debt-amount">{t("amountLabel")}</FieldLabel>
                <FieldControl>
                  <AmountField
                    {...field}
                    id="member-debt-amount"
                    size="3"
                    inputMode={minorUnitExponent(currency) > 0 ? "decimal" : "numeric"}
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Controller
            name="currency"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="member-debt-currency">{t("currencyLabel")}</FieldLabel>
                <Select.Root size="3" value={field.value} onValueChange={field.onChange} disabled={isPending}>
                  <FieldControl>
                    <Select.Trigger id="member-debt-currency" />
                  </FieldControl>
                  <Select.Content position="popper">
                    {OFFERED_CURRENCIES.map((code) => (
                      <Select.Item key={code} value={code}>
                        {code}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Field>
            )}
          />
        </Flex>

        <Controller
          name="occurredOn"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="member-debt-date">{t("dateLabel")}</FieldLabel>
              <FieldControl>
                <DateInput {...field} id="member-debt-date" size="3" disabled={isPending} />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="member-debt-description">{t("descriptionLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  value={field.value ?? ""}
                  id="member-debt-description"
                  size="3"
                  placeholder={t("descriptionPlaceholder")}
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
              <Button type="button" variant="soft" color="gray" disabled={isPending}>
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
