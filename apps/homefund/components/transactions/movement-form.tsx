"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronLeftIcon, InfoIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Controller,
  useForm,
  useWatch,
  type Resolver,
} from "react-hook-form";

import {
  createTransactionAction,
  updateTransactionAction,
} from "@/app/actions/transactions";
import { acceptDeliveryAction } from "@/app/actions/ingest";
import { proposeRateAction } from "@/app/actions/rates";
import { SplitEditor } from "@/components/transactions/split-editor";
import {
  Badge,
  Box,
  Button,
  Callout,
  ChipMultiSelect,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Figure,
  Flex,
  FundChip,
  Grid,
  Heading,
  IconButton,
  Select,
  Spinner,
  Text,
  TextField,
  type Responsive,
} from "@/components/ui";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import type { TransactionListRow } from "@/db/queries/transactions";
import {
  BASE_CURRENCY,
  type CurrencyCode,
  OFFERED_CURRENCIES,
} from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import {
  amountToInput,
  convertMinor,
  deriveRate,
  formatMoney,
  parseAmount,
} from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  acceptDeliverySchema,
  type AcceptDeliveryInput,
} from "@/lib/validation/ingest";
import {
  createTransactionSchema,
  foreignSettlementCurrency,
  refineSettlement,
  updateTransactionSchema,
  type CreateTransactionInput,
  type SettlementCurrencies,
  type UpdateTransactionInput,
} from "@/lib/validation/transaction";

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so `external_ref` never reaches the edit
// action and `transaction_id` never reaches the create one.
type MovementFormValues = {
  deliveryId?: string;
  transactionId?: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  currency: CurrencyCode;
  counterAmount: string | null;
  counterIsEstimate: boolean;
  occurredAt: string;
  description: string | null;
  externalRef?: string;
  splits: { categoryId: string; amount: string }[];
  labelIds: string[];
  causedByTransactionId: string | null;
};

// The kind the DB generates from the accounts (RF-18): a lone destination is an
// income, a lone source an expense, both a transfer, neither nothing yet.
type DerivedKind = "income" | "expense" | "transfer" | null;

function deriveKind(
  fromAccountId: string | null,
  toAccountId: string | null,
): DerivedKind {
  if (fromAccountId && toAccountId) return "transfer";
  if (toAccountId) return "income";
  if (fromAccountId) return "expense";
  return null;
}

/**
 * The dialog this form is laid out for: the 884px of the FormMovimiento artboard
 * from `md` up, and below it the width Radix gives every dialog. Every caller
 * reads it from here, so the form is never opened narrower than its two columns.
 */
export const movementFormDialogWidth: Responsive<string> = {
  initial: "600px",
  md: "884px",
};

// The artboard's body: the accounts, the figure, the date and the note on the
// fixed track, the splits and the labels on what is left.
const BODY_COLUMNS = "400px 1fr";

// Enough for a three-letter code and the chevron beside it, and no more: the
// amount keeps the rest of the line.
const CURRENCY_FIELD = "116px";

// A rate is read, not counted with: enough figures to recognise it, whichever
// way round the two currencies are.
const RATE_FORMAT = { maximumSignificantDigits: 6 } as const;

// A sentinel the account selects use for "no account", since a Radix item may
// not carry an empty value; it maps back to null the moment it is picked.
const NO_ACCOUNT = "none";

// The same trick for the cause picker: nothing chosen is a movement that names
// no cause, which is every movement most days (RF-132).
const NO_CAUSE = "none";

// What the two named accounts settle in, off the map the options already carry
// (RF-121): no read of its own, and the same pair the action reads back from the
// accounts before it writes.
function settlementOf(
  accounts: Record<string, CurrencyCode>,
  fromAccountId: string | null,
  toAccountId: string | null,
): SettlementCurrencies {
  return {
    from: fromAccountId === null ? null : accounts[fromAccountId] ?? null,
    to: toAccountId === null ? null : accounts[toAccountId] ?? null,
  };
}

/**
 * The full movement form: income, expense and transfer through one screen where
 * the type is never chosen but derived from the two account slots and shown
 * read-only (RF-18). An income or expense reuses the shared `SplitEditor` with a
 * category set of its own scope and kind (RF-62, RF-69); a transfer hides both.
 * It writes through the same actions and the same Zod schema the server runs,
 * and reopens on any movement to edit it (RF-24). Money is integer cents.
 */
export function MovementForm({
  mode,
  options,
  movement,
  deliveryId,
  defaults,
  causeOptions = [],
  causedByTransactionId = null,
  onSaved,
  onDone,
}: {
  mode: "create" | "edit";
  options: TransactionFormOptions;
  movement?: TransactionListRow;
  deliveryId?: string;
  // The movements the cause picker offers, the one already named among them so
  // it keeps its words; an empty set leaves the picker off the form entirely.
  causeOptions?: TransactionListRow[];
  // The cause the movement already names, seeded into the picker so an edit
  // that ignores it leaves it where it was (RF-132).
  causedByTransactionId?: string | null;
  defaults?: {
    fromAccountId?: string | null;
    toAccountId?: string | null;
    amount?: string;
    occurredAt?: string;
    description?: string | null;
    splits?: { categoryId: string; amount: string }[];
  };
  // Runs on a stored write only; `onDone` also runs on the back button.
  onSaved?: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("transactions");
  const tIngest = useTranslations("ingest");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const onActionError = useActionErrorToast();
  // One key per opening: a save sent again after a lost answer carries the same one, and the
  // form unmounts on close, so the next opening mints its own.
  const [requestRef] = useState(() => crypto.randomUUID());
  const [stale, setStale] = useState(false);

  const isEdit = mode === "edit";
  const isAccept = !movement && deliveryId !== undefined;

  // The currency the empty form opens in: what the account it opens on settles
  // in, so the common movement is already in the right one (RF-121).
  // Only accounts the person may write, plus the ones the form opened naming.
  const held = [
    movement?.fromAccountId,
    movement?.toAccountId,
    defaults?.fromAccountId,
    defaults?.toAccountId,
  ];
  const writableAccounts = options.accounts.filter(
    (account) => account.canWrite || held.includes(account.id),
  );
  // The last-used account opens the form only while it is on offer.
  const lastUsedAccountId = writableAccounts.some(
    (account) => account.id === options.lastUsedAccountId,
  )
    ? options.lastUsedAccountId
    : null;

  const openingAccountId =
    defaults?.fromAccountId ?? defaults?.toAccountId ?? lastUsedAccountId;

  // The settlement rules need what each named account settles in, and the values
  // under validation name the accounts: the resolver reads the pair off them and
  // refines the mode's own schema with it, so the form refuses exactly what the
  // action refuses against the currencies it reads back (RNF-10).
  const resolver: Resolver<MovementFormValues> = (values, context, options_) => {
    const schema = (
      isEdit
        ? updateTransactionSchema
        : isAccept
          ? acceptDeliverySchema
          : createTransactionSchema
    ).superRefine(
      refineSettlement(
        settlementOf(
          options.accountCurrencies,
          values.fromAccountId,
          values.toAccountId,
        ),
      ),
    );

    return (zodResolver(schema) as unknown as Resolver<MovementFormValues>)(
      values,
      context,
      options_,
    );
  };

  const form = useForm<MovementFormValues>({
    resolver,
    mode: "onChange",
    defaultValues: movement
      ? {
          transactionId: movement.id,
          fromAccountId: movement.fromAccountId,
          toAccountId: movement.toAccountId,
          amount: amountToInput(movement.amountCents, movement.currency),
          currency: movement.currency,
          counterAmount:
            movement.counterAmountCents === null
              ? null
              : amountToInput(
                  movement.counterAmountCents,
                  foreignSettlementCurrency(movement.currency, {
                    from: movement.fromSettlementCurrency,
                    to: movement.toSettlementCurrency,
                  }) ?? movement.currency,
                ),
          counterIsEstimate: movement.counterIsEstimate,
          occurredAt: movement.occurredAt,
          description: movement.description,
          splits: movement.splits.map((split) => ({
            categoryId: split.categoryId,
            amount: amountToInput(split.amountCents, movement.currency),
          })),
          labelIds: movement.labels.map((label) => label.id),
          causedByTransactionId,
        }
      : {
          deliveryId: isAccept ? deliveryId : undefined,
          // Reached from the quick sheet's income-or-transfer link, so the empty
          // form opens as an income: a destination and no source (RF-18).
          fromAccountId:
            defaults?.fromAccountId !== undefined
              ? defaults.fromAccountId
              : null,
          toAccountId:
            defaults?.toAccountId !== undefined
              ? defaults.toAccountId
              : lastUsedAccountId,
          amount: defaults?.amount ?? "",
          currency:
            (openingAccountId && options.accountCurrencies[openingAccountId]) ??
            BASE_CURRENCY,
          counterAmount: null,
          counterIsEstimate: false,
          occurredAt: defaults?.occurredAt ?? todayInBogota(),
          description:
            defaults?.description !== undefined ? defaults.description : null,
          splits: defaults?.splits ?? [],
          labelIds: [],
          causedByTransactionId,
        },
  });

  const fromAccountId = useWatch({ control: form.control, name: "fromAccountId" });
  const toAccountId = useWatch({ control: form.control, name: "toAccountId" });
  const amount = useWatch({ control: form.control, name: "amount" });
  const currency = useWatch({ control: form.control, name: "currency" });
  const counterAmount = useWatch({ control: form.control, name: "counterAmount" });
  const counterIsEstimate = useWatch({
    control: form.control,
    name: "counterIsEstimate",
  });
  const splits = useWatch({ control: form.control, name: "splits" });

  const kind = deriveKind(fromAccountId, toAccountId);

  const settlement = useMemo(
    () => settlementOf(options.accountCurrencies, fromAccountId, toAccountId),
    [options.accountCurrencies, fromAccountId, toAccountId],
  );

  // The side that settles somewhere else, and what it settles in: while it is
  // null the screen shows nothing beyond the amount, which is every movement a
  // person records in the currency their account already holds (RF-122).
  const foreign = foreignSettlementCurrency(currency, settlement);

  // The currency the accounts point at, which the selector opens on and follows
  // while nobody has picked another one.
  const accountCurrency = settlement.from ?? settlement.to;
  // No account chosen yet reads as BASE_CURRENCY, the same fallback `currency`
  // itself opens on (above): the two must start in step, or the guard below reads
  // the field's own default as an already-chosen override and refuses to follow
  // the very first account a person picks.
  const lastAccountCurrency = useRef(accountCurrency ?? BASE_CURRENCY);
  useEffect(() => {
    if (accountCurrency === null || accountCurrency === lastAccountCurrency.current) {
      return;
    }

    // Only what this effect itself put there moves: a currency a person chose
    // survives a change of account.
    const wasFollowing = currency === lastAccountCurrency.current;
    lastAccountCurrency.current = accountCurrency;
    if (wasFollowing) {
      form.setValue("currency", accountCurrency, { shouldValidate: true });
    }
  }, [accountCurrency, currency, form]);

  // The second amount belongs to a movement whose account settles elsewhere and
  // to no other, and only a one-sided one is still waiting for a statement: a
  // transfer is confirmed whole the moment it is recorded (RF-122, RF-123).
  useEffect(() => {
    if (foreign === null) {
      if (counterAmount !== null) {
        form.setValue("counterAmount", null, { shouldValidate: true });
      }
      if (counterIsEstimate) form.setValue("counterIsEstimate", false);
      return;
    }

    if (kind === "transfer") {
      if (counterIsEstimate) form.setValue("counterIsEstimate", false);
      return;
    }

    // What a person expects to be billed until the statement replaces it. An
    // edit keeps the mark the movement already carries.
    if (!isEdit && !counterIsEstimate) form.setValue("counterIsEstimate", true);
  }, [foreign, kind, counterAmount, counterIsEstimate, isEdit, form]);

  // Both accounts share one writable scope (RF-62): whichever slot is set names
  // it, and that scope decides which categories the split editor offers.
  const scopeAccountId = fromAccountId ?? toAccountId;
  const scope = useMemo(() => {
    const account = options.accounts.find((one) => one.id === scopeAccountId);
    return account?.groupId ? "group" : "personal";
  }, [options.accounts, scopeAccountId]);

  const isGroupScoped = kind !== null && scope === "group";

  // A movement is never its own cause (RF-132), so the movement under edit is
  // dropped from what the picker offers; the rest arrive already ordered.
  const causeCandidates = useMemo(
    () => causeOptions.filter((row) => row.id !== movement?.id),
    [causeOptions, movement?.id],
  );

  // A movement's labels share its scope, so only that scope's set is on offer
  // (RF-70); the other scope's would be refused by the check on write.
  const scopedLabels = useMemo(
    () => options.labels.filter((label) => label.scope === scope),
    [options.labels, scope],
  );

  // Keep the splits in step with the derived kind: a transfer drops them, and a
  // switch between income and expense clears the categories the old kind carried
  // (RF-69). A lone split always holds the whole amount, like the quick sheet.
  const lastKind = useRef<DerivedKind>(kind);
  useEffect(() => {
    if (kind === "transfer") {
      if (splits.length > 0) form.setValue("splits", [], { shouldValidate: true });
      lastKind.current = kind;
      return;
    }

    if (kind === null) {
      if (splits.length > 0) form.setValue("splits", [], { shouldValidate: true });
      lastKind.current = kind;
      return;
    }

    // A row with no category yet is what the person came to fill, not a
    // mistake to report: seeding it never validates, so the form opens quiet.
    if (lastKind.current !== kind && lastKind.current !== null) {
      form.setValue("splits", [{ categoryId: "", amount }]);
    } else if (splits.length === 0) {
      form.setValue("splits", [{ categoryId: "", amount }]);
    } else if (splits.length === 1 && splits[0].amount !== amount) {
      form.setValue("splits", [{ ...splits[0], amount }], { shouldValidate: true });
    }

    lastKind.current = kind;
  }, [kind, splits, amount, form]);

  // Switching to an account of the other scope drops the selection, so a
  // personal label never rides into a group movement.
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    form.setValue("labelIds", [], { shouldValidate: true });
  }, [scope, form]);

  function onActionSuccess() {
    onSaved?.();
    onDone();
  }

  // Three hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createTransactionAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateTransactionAction, {
    onSuccess: onActionSuccess,
    onError: (result) => {
      if (result.error.serverError === "errors.stale") setStale(true);
      else onActionError(result);
    },
  });
  const accept = useAction(acceptDeliveryAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit
    ? update.isPending
    : isAccept
      ? accept.isPending
      : create.isPending;

  function onSubmit(values: MovementFormValues) {
    // The resolver already parsed `values` for this mode, dropping the field the
    // other mode's action refuses: `external_ref` on edit, `transaction_id` on
    // create.
    if (isEdit) {
      setStale(false);
      update.execute({
        ...(values as UpdateTransactionInput),
        expectedUpdatedAt: movement?.updatedAt,
      });
    } else if (isAccept) {
      accept.execute({ ...values, deliveryId } as AcceptDeliveryInput);
    } else {
      create.execute({ ...(values as CreateTransactionInput), requestRef });
    }
  }

  function causeOptionLabel(row: TransactionListRow): string {
    const name =
      row.description ??
      (row.kind === "income"
        ? t("kindIncome")
        : row.kind === "transfer"
          ? t("kindTransfer")
          : t("kindExpense"));
    const day = format.dateTime(civilDateToDate(row.occurredAt), {
      day: "numeric",
      month: "short",
    });
    return `${name} · ${day} · ${formatMoney(row.amountCents, row.currency, locale)}`;
  }

  const kindLabel =
    kind === "income"
      ? t("kindIncome")
      : kind === "expense"
        ? t("kindExpense")
        : kind === "transfer"
          ? t("kindTransfer")
          : null;
  const kindColor =
    kind === "income" ? "grass" : kind === "expense" ? "red" : "gray";
  const sign = kind === "income" ? "+" : kind === "expense" ? "−" : "";
  const amountMinor = parseAmount(amount);
  const counterMinor =
    foreign === null || counterAmount === null ? null : parseAmount(counterAmount);

  // The quotient of the two figures, and nothing else: it is read, never typed
  // and never stored (RF-122). A stored rate would be money in floating point.
  const rate =
    foreign !== null && amountMinor !== null && counterMinor !== null && amountMinor > 0
      ? deriveRate(amountMinor, currency, counterMinor, foreign)
      : null;

  // The proposal a person may take or ignore (RF-122): a source down, too slow
  // or missing one of the two currencies leaves this on, and the field waits
  // for a figure typed by hand instead of one this screen invented.
  const [rateUnavailable, setRateUnavailable] = useState(false);
  const lastForeign = useRef(foreign);
  useEffect(() => {
    if (foreign !== lastForeign.current) {
      lastForeign.current = foreign;
      setRateUnavailable(false);
    }
  }, [foreign]);

  const proposeRate = useAction(proposeRateAction, {
    onSuccess: ({ data }) => {
      if (!data || amountMinor === null || foreign === null) {
        setRateUnavailable(true);
        return;
      }
      // The stored scale is the same 100 for every currency (RF-121), so the
      // quotient converts minor to minor with no exponent of its own to read.
      setRateUnavailable(false);
      form.setValue(
        "counterAmount",
        amountToInput(convertMinor(amountMinor, data.rate), foreign),
        { shouldValidate: true },
      );
    },
    onError: () => setRateUnavailable(true),
  });

  function handleSuggestRate() {
    if (foreign === null || amountMinor === null || amountMinor <= 0) return;
    proposeRate.execute({ from: currency, to: foreign });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <Flex align="center" gap="3" mb="4">
        <IconButton
          type="button"
          tap
          variant="ghost"
          color="gray"
          onClick={onDone}
          disabled={isPending}
          aria-label={tKey("common.cancel")}
        >
          <ChevronLeftIcon size={18} />
        </IconButton>
        <Flex flexGrow="1" minWidth="0">
          <Heading size="5">{t(isEdit ? "editTitle" : "formTitle")}</Heading>
        </Flex>
        {isGroupScoped && <FundChip label={tKey("fund.label")} />}
      </Flex>

      {/* The amount reads in the derived kind's sign and colour; the pill names
          the kind read-only, never a control (RF-18). */}
      <Flex direction="column" align="center" gap="2" mb="5">
        <Figure as="h1" size="8" color={kindColor}>
          {`${sign}${formatMoney(amountMinor ?? 0, currency, locale)}`}
        </Figure>
        {kindLabel && (
          <Flex align="center" gap="2">
            <Badge color={kindColor} variant="soft" radius="full">
              {kindLabel}
            </Badge>
            <Text size="1" color="gray">
              {t("kindDerivedFrom")}
            </Text>
          </Flex>
        )}
      </Flex>

      {/* The artboard's body from `md` up: the accounts and the figure on the
          fixed track, the splits and the labels on what is left, the date and
          the note under the accounts. Below `md` it is one column, and every
          field keeps the row it already had. */}
      <Grid
        columns={{ initial: "1", md: BODY_COLUMNS }}
        gap="5"
        align="start"
        width="100%"
      >
        <FieldGroup>
          <Controller
            name="fromAccountId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="movement-from">{t("fromLabel")}</FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value ?? NO_ACCOUNT}
                  onValueChange={(value) =>
                    field.onChange(value === NO_ACCOUNT ? null : value)
                  }
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="movement-from" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={NO_ACCOUNT}>{t("accountNone")}</Select.Item>
                    {writableAccounts.map((account) => (
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
                <FieldLabel htmlFor="movement-to">{t("toLabel")}</FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value ?? NO_ACCOUNT}
                  onValueChange={(value) =>
                    field.onChange(value === NO_ACCOUNT ? null : value)
                  }
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="movement-to" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={NO_ACCOUNT}>{t("accountNone")}</Select.Item>
                    {writableAccounts.map((account) => (
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

          {/* The figure and the currency it is in, on one line: while the
              currency is the account's own — every movement most days — this is
              the amount field it has always been (RF-121). */}
          <Flex align="start" gap="3" width="100%">
            <Box flexGrow="1" minWidth="0">
              <Controller
                name="amount"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="movement-amount">
                      {t("amountLabel")}
                    </FieldLabel>
                    <FieldControl>
                      <TextField.Root
                        {...field}
                        id="movement-amount"
                        size="3"
                        inputMode="numeric"
                        disabled={isPending}
                      />
                    </FieldControl>
                    <FieldMessage error={fieldState.error} />
                  </Field>
                )}
              />
            </Box>

            <Box width={CURRENCY_FIELD}>
              <Controller
                name="currency"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="movement-currency">
                      {t("currencyLabel")}
                    </FieldLabel>
                    <Select.Root
                      size="3"
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={isPending}
                    >
                      <FieldControl>
                        <Select.Trigger id="movement-currency" />
                      </FieldControl>
                      <Select.Content position="popper">
                        {OFFERED_CURRENCIES.map((code) => (
                          <Select.Item key={code} value={code}>
                            {code}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                    <FieldMessage error={fieldState.error} />
                  </Field>
                )}
              />
            </Box>
          </Flex>

          {/* The other side of a movement whose account settles elsewhere: what
              it is expected to cost there while a statement is still to come
              (RF-123), or what actually landed when both accounts are the
              caller's own. Without it the movement is not written. */}
          {foreign !== null && (
            <Controller
              name="counterAmount"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="movement-counter-amount">
                    <Flex as="span" align="center" gap="2">
                      {t("counterAmountLabel")}
                      <Text size="2" weight="regular" color="gray">
                        {foreign}
                      </Text>
                      {counterIsEstimate && (
                        <Badge color="amber" variant="soft" radius="full">
                          {t("estimated")}
                        </Badge>
                      )}
                    </Flex>
                  </FieldLabel>
                  <Flex align="start" gap="3" width="100%">
                    <Box flexGrow="1" minWidth="0">
                      <FieldControl>
                        <TextField.Root
                          id="movement-counter-amount"
                          size="3"
                          inputMode="numeric"
                          disabled={isPending}
                          value={field.value ?? ""}
                          onChange={(event) =>
                            field.onChange(event.target.value || null)
                          }
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FieldControl>
                    </Box>
                    {/* Proposes a figure, never one this screen writes on its
                        own (RF-122): the field above still saves whatever a
                        person leaves or types in it. */}
                    <Button
                      type="button"
                      size="3"
                      variant="soft"
                      disabled={
                        isPending ||
                        proposeRate.isPending ||
                        amountMinor === null ||
                        amountMinor <= 0
                      }
                      onClick={handleSuggestRate}
                    >
                      {proposeRate.isPending && <Spinner />}
                      {t("suggestRate")}
                    </Button>
                  </Flex>
                  {rateUnavailable && (
                    <Text size="1" color="amber">
                      {t("rateUnavailable")}
                    </Text>
                  )}
                  <Text size="1" color="gray">
                    {t("counterAmountHint")}
                  </Text>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          )}

          {/* Derived, and said to be: the quotient of the two figures above,
              which nobody types and nothing stores (RF-122). */}
          {rate !== null && (
            <Flex direction="column" gap="1">
              <Flex align="center" justify="between" gap="3">
                <Text size="2" color="gray">
                  {t("rateLabel")}
                </Text>
                <Figure size="2" weight="medium">
                  {t("rateLine", {
                    currency,
                    rate: format.number(rate, RATE_FORMAT),
                    foreign: foreign ?? "",
                  })}
                </Figure>
              </Flex>
              <Text size="1" color="gray">
                {t("rateDerived")}
              </Text>
            </Flex>
          )}
        </FieldGroup>

        {/* Two rows tall, because the splits grow with the categories while the
            track beside them holds five fields at rest. */}
        <Box gridColumn={{ md: "2" }} gridRow={{ md: "1 / span 2" }} width="100%">
          <FieldGroup>
            {/* Category and splits belong to an income or expense only; a transfer
                carries neither (RF-69). */}
            {(kind === "income" || kind === "expense") && (
              <Controller
                name="splits"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel>{t("categoryLabel")}</FieldLabel>
                    <SplitEditor
                      total={amount}
                      currency={currency}
                      scope={scope}
                      kind={kind}
                      categories={options.categories}
                      value={field.value}
                      onChange={field.onChange}
                    />
                    <FieldMessage error={fieldState.error} />
                  </Field>
                )}
              />
            )}

            {/* A transfer carries no split but may carry labels, so the picker
                mounts for every derived kind (RF-70). */}
            <Controller
              name="labelIds"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  {scopedLabels.length === 0 ? (
                    <>
                      <FieldLabel>{t("labelsLabel")}</FieldLabel>
                      <Text size="2" color="gray">
                        {t("labelsNone")}
                      </Text>
                    </>
                  ) : (
                    <FieldControl>
                      <ChipMultiSelect
                        id="movement-labels"
                        name="labelIds"
                        value={field.value}
                        onValueChange={field.onChange}
                        options={scopedLabels}
                        label={t("labelsLabel")}
                        disabled={isPending}
                      />
                    </FieldControl>
                  )}
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          </FieldGroup>
        </Box>

        <FieldGroup>
          <Controller
            name="occurredAt"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="movement-date">{t("dateLabel")}</FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="movement-date"
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
            name="description"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="movement-note">
                  <Flex as="span" align="center" gap="1">
                    {t("note")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="movement-note"
                    size="3"
                    autoComplete="off"
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
          {/* The movement this one is a charge on (RF-132). Nothing on the
              form waits for it, and no caller is asked to fill it. */}
          {causeCandidates.length > 0 && (
            <Controller
              name="causedByTransactionId"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="movement-cause">
                    <Flex as="span" align="center" gap="1">
                      {t("causeField")}
                      <Text size="2" weight="regular" color="gray">
                        {tKey("common.optional")}
                      </Text>
                    </Flex>
                  </FieldLabel>
                  <Select.Root
                    size="3"
                    value={field.value ?? NO_CAUSE}
                    onValueChange={(value) =>
                      field.onChange(value === NO_CAUSE ? null : value)
                    }
                    disabled={isPending}
                  >
                    <FieldControl>
                      <Select.Trigger
                        id="movement-cause"
                        placeholder={t("causePlaceholder")}
                      />
                    </FieldControl>
                    <Select.Content position="popper">
                      <Select.Item value={NO_CAUSE}>{t("causeNone")}</Select.Item>
                      {causeCandidates.map((row) => (
                        <Select.Item key={row.id} value={row.id}>
                          {causeOptionLabel(row)}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          )}
        </FieldGroup>

        <Box gridColumn={{ md: "1 / -1" }} width="100%">
          <FieldGroup>
            <Callout.Root color="jade" variant="soft">
              <Callout.Icon>
                <InfoIcon size={16} />
              </Callout.Icon>
              <Callout.Text>{t("kindDerivedHint")}</Callout.Text>
            </Callout.Root>

            {stale && (
              <Callout.Root color="red" variant="soft" role="alert">
                <Callout.Icon>
                  <InfoIcon size={16} />
                </Callout.Icon>
                <Callout.Text>{tKey("errors.stale")}</Callout.Text>
              </Callout.Root>
            )}

            {/* Never dead: while the form is short of something, submitting is what
                makes it say so. */}
            <Button type="submit" size="3" disabled={isPending}>
              {isPending && <Spinner />}
              {isAccept ? tIngest("accept") : t("saveMovement")}
            </Button>
          </FieldGroup>
        </Box>
      </Grid>
    </form>
  );
}
