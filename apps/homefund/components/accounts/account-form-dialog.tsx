"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { createAccountAction, updateAccountAction } from "@/app/actions/accounts";
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
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import { BASE_CURRENCY, OFFERED_CURRENCIES } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  ACCOUNT_KINDS,
  ACCOUNT_PLACEMENTS,
  ACCOUNT_SUBTYPES,
  SUBTYPES_BY_KIND,
  createAccountSchema,
  updateAccountSchema,
  type CreateAccountInput,
  type UpdateAccountInput,
} from "@/lib/validation/account";

// The message key naming each subtype's segment, kept beside the enum it maps.
const SUBTYPE_LABEL_KEYS = {
  bancaria: "subtypeBancaria",
  efectivo: "subtypeEfectivo",
  tarjeta: "subtypeTarjeta",
} as const;

// The kind that admits a class, mirroring SUBTYPES_BY_KIND: a card is money owed,
// anything else holds value.
function kindForSubtype(
  subtype: (typeof ACCOUNT_SUBTYPES)[number],
): (typeof ACCOUNT_KINDS)[number] {
  return (SUBTYPES_BY_KIND.liability as readonly string[]).includes(subtype)
    ? "liability"
    : "asset";
}

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so only the fields that schema needs ever
// reach the matching action.
type AccountFormValues = {
  accountId: string;
  name: string;
  kind: (typeof ACCOUNT_KINDS)[number];
  subtype: (typeof ACCOUNT_SUBTYPES)[number];
  placement: (typeof ACCOUNT_PLACEMENTS)[number];
  isShared: boolean;
  institution: string;
  lastFour: string;
  settlementCurrency: (typeof OFFERED_CURRENCIES)[number];
  amount: string;
  balanceOn: string;
};

export function AccountFormDialog({
  hasGroup,
  open,
  onOpenChange,
  account,
  defaultSubtype,
}: {
  hasGroup: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: AccountRow;
  // The class a new account starts on, when the screen was reached asking for one.
  defaultSubtype?: (typeof ACCOUNT_SUBTYPES)[number];
}) {
  const t = useTranslations("accounts");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{account ? t("editTitle") : t("addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <AccountForm
          key={account?.id ?? "create"}
          hasGroup={hasGroup}
          account={account}
          defaultSubtype={defaultSubtype}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function AccountForm({
  hasGroup,
  account,
  defaultSubtype,
  onOpenChange,
}: {
  hasGroup: boolean;
  account?: AccountRow;
  defaultSubtype?: (typeof ACCOUNT_SUBTYPES)[number];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("accounts");
  // Root-scoped: the keys under `common` sit outside the `accounts` namespace.
  const tKey = useTranslations();

  const isEdit = !!account;

  const form = useForm<AccountFormValues>({
    resolver: (isEdit
      ? zodResolver(updateAccountSchema)
      : zodResolver(createAccountSchema)) as unknown as Resolver<AccountFormValues>,
    defaultValues: account
      ? {
          accountId: account.id,
          name: account.name,
          kind: account.kind,
          subtype: account.subtype,
          // A row names its owner XOR its group; the placement is fixed on edit.
          placement: account.ownerUserId ? "personal" : "group",
          isShared: account.isShared,
          institution: account.institution ?? "",
          lastFour: account.lastFour ?? "",
          settlementCurrency: account
            .settlementCurrency as (typeof OFFERED_CURRENCIES)[number],
          // The stored integer is already in this currency's minor unit, so the
          // field shows it with the decimals that currency has and no others.
          amount: amountToInput(
            Math.abs(account.initialBalanceCents),
            account.settlementCurrency,
          ),
          balanceOn: account.initialBalanceOn,
        }
      : {
          accountId: "",
          name: "",
          // The kind follows the class, so a pre-chosen card opens as a liability.
          kind: kindForSubtype(defaultSubtype ?? "bancaria"),
          // A new asset is a bank account unless the user picks cash (RF-56).
          subtype: defaultSubtype ?? "bancaria",
          placement: "personal",
          isShared: false,
          institution: "",
          lastFour: "",
          settlementCurrency: BASE_CURRENCY as (typeof OFFERED_CURRENCIES)[number],
          amount: "",
          balanceOn: todayInBogota(),
        },
  });

  // Drives the amount label: it reads differently for an asset than for a debt.
  const kind = useWatch({ control: form.control, name: "kind" });
  const amountLabel =
    kind === "liability" ? t("openingOwedLabel") : t("openingBalanceLabel");

  // The control offers only the subtypes the kind admits (accounts_subtype_kind):
  // an asset stays bank-or-cash, a liability is always a card. On edit the kind is
  // locked, so this is fixed; on create it follows the kind toggle below.
  const subtypeOptions = SUBTYPES_BY_KIND[kind];

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createAccountAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateAccountAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: AccountFormValues) {
    // The resolver already parsed `values` against the schema for this mode,
    // stripping the field the other mode's action does not accept.
    if (isEdit) {
      update.execute(values as UpdateAccountInput);
    } else {
      create.execute(values as CreateAccountInput);
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
              <FieldLabel htmlFor="account-name">{t("nameLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="account-name"
                  size="3"
                  autoFocus
                  autoComplete="off"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        {isEdit ? (
          <Field>
            {/* Not labelable: a read-only Text names nothing a <label> can target. */}
            <FieldLabel>{t("kindLabel")}</FieldLabel>
            {/* Kind is absent from the update grant: a control here would
                promise a change the database refuses. */}
            <Text size="3">
              {account.kind === "liability" ? t("kindLiability") : t("kindAsset")}
            </Text>
            <FieldDescription>{t("kindLocked")}</FieldDescription>
          </Field>
        ) : (
          <Controller
            name="kind"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel id="account-kind-label">{t("kindLabel")}</FieldLabel>
                <FieldControl>
                  <SegmentedControl.Root
                    size="3"
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      // Carry the subtype under the new kind: a liability is a
                      // card, an asset falls back to a bank account.
                      form.setValue(
                        "subtype",
                        value === "liability" ? "tarjeta" : "bancaria",
                      );
                    }}
                    aria-labelledby="account-kind-label"
                  >
                    <SegmentedControl.Item value="asset">
                      {t("kindAsset")}
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="liability">
                      {t("kindLiability")}
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}
        {/* What the account is (RF-56): bank, cash, or a card. The options are
            filtered to the kind, so a card never sits under an asset. */}
        <Controller
          name="subtype"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel id="account-subtype-label">{t("subtypeLabel")}</FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-labelledby="account-subtype-label"
                >
                  {subtypeOptions.map((subtype) => (
                    <SegmentedControl.Item key={subtype} value={subtype}>
                      {t(SUBTYPE_LABEL_KEYS[subtype])}
                    </SegmentedControl.Item>
                  ))}
                </SegmentedControl.Root>
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        {/* Placement is set at creation and immutable after (RF-60): a personal
            account is the caller's own; a group account is offered only when they
            belong to one. On edit the picker is gone, like `kind`. */}
        {!isEdit && hasGroup && (
          <Controller
            name="placement"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="account-owner">{t("ownerLabel")}</FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="account-owner" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value="personal">
                      {t("ownerPersonal")}
                    </Select.Item>
                    <Select.Item value="group">{t("ownerFund")}</Select.Item>
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}
        <Controller
          name="institution"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="account-institution">
                <Flex as="span" align="center" gap="1">
                  {t("institutionLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="account-institution"
                  size="3"
                  autoComplete="organization"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Controller
          name="lastFour"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="account-last-four">
                <Flex as="span" align="center" gap="1">
                  {t("lastFourLabel")}
                  <Text size="2" weight="regular" color="gray">
                    {tKey("common.optional")}
                  </Text>
                </Flex>
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="account-last-four"
                  size="3"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="off"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldDescription>{t("lastFourDescription")}</FieldDescription>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        {/* Above the amount because it decides how the amount reads (RF-121):
            "10,50" is a dollar figure and no peso figure at all. */}
        <Controller
          name="settlementCurrency"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="account-currency">
                {t("settlementCurrencyLabel")}
              </FieldLabel>
              <Select.Root
                size="3"
                value={field.value}
                onValueChange={field.onChange}
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="account-currency" />
                </FieldControl>
                <Select.Content position="popper">
                  {OFFERED_CURRENCIES.map((currency) => (
                    <Select.Item key={currency} value={currency}>
                      {currency}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <FieldDescription>{t("settlementCurrencyHint")}</FieldDescription>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Controller
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="account-amount">{amountLabel}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="account-amount"
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
          name="balanceOn"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="account-balance-on">
                {t("openingBalanceOnLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="account-balance-on"
                  size="3"
                  type="date"
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
              {tKey("common.save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
