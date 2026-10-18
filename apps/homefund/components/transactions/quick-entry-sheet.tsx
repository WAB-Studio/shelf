"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SquarePenIcon, XIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import {
  createTransactionAction,
  deleteTransactionAction,
} from "@/app/actions/transactions";
import { SplitEditor } from "@/components/transactions/split-editor";
import {
  Button,
  ChipMultiSelect,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  IconButton,
  Link,
  RadioCards,
  Select,
  Spinner,
  TapTarget,
  Text,
  TextField,
} from "@/components/ui";
import type {
  OfferedCurrency,
  TransactionFormOptions,
} from "@/db/queries/transaction-form";
import { BASE_CURRENCY } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { amountToInput, formatMoney } from "@/lib/money";
import {
  interpretQuickEntry,
  type AmountAsk,
} from "@/lib/transactions/interpret";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createTransactionSchema,
  type CreateTransactionInput,
} from "@/lib/validation/transaction";

// What an account settles in, or the base currency while none is chosen (RF-121).
function accountCurrencyOf(
  options: TransactionFormOptions,
  accountId: string | null,
): OfferedCurrency {
  if (accountId === null) return BASE_CURRENCY;
  return options.accountCurrencies[accountId] ?? BASE_CURRENCY;
}

/**
 * The make-or-break quick sheet: one text field the interpreter reads into an
 * editable expense (RF-22). It is fixed to an expense — a source account, no
 * destination — so the type is never chosen (RF-18); income and transfer live
 * in the full form the "Income or transfer?" link opens.
 */
export function QuickEntrySheet({
  open,
  onOpenChange,
  options,
  onOpenFull,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: TransactionFormOptions;
  onOpenFull: () => void;
}) {
  const t = useTranslations("transactions");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* The centred panel of the EntradaRapida artboard from `md` up; below it
          the sheet keeps the width Radix gives every dialog on a phone, minus
          the overlay's own 16px on each side. Radix sizes a dialog to the
          min-content of what it holds, and the split row's category trigger
          carries a whole category name on one line, so without this the sheet
          grows past the viewport instead of the row shrinking inside it. */}
      <Dialog.Content
        maxWidth={{ initial: "min(600px, 100vw - 32px)", md: "576px" }}
      >
        <Flex align="center" justify="between" mb="4">
          <Dialog.Title mb="0">{t("quickTitle")}</Dialog.Title>
          <Dialog.Close>
            <IconButton
              type="button"
              tap
              variant="ghost"
              color="gray"
              aria-label={t("quickTitle")}
            >
              <XIcon size={18} />
            </IconButton>
          </Dialog.Close>
        </Flex>
        {/* Closing unmounts the content, so the form is born fresh each open. */}
        <QuickEntryForm
          options={options}
          onOpenChange={onOpenChange}
          onOpenFull={onOpenFull}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

// The sheet's own value shape: the create payload with the three fields a
// writer may leave to the accounts already decided, since the sheet always
// names them.
type QuickEntryValues = CreateTransactionInput & {
  currency: OfferedCurrency;
  counterAmount: string | null;
  counterIsEstimate: boolean;
};

function QuickEntryForm({
  options,
  onOpenChange,
  onOpenFull,
}: {
  options: TransactionFormOptions;
  onOpenChange: (open: boolean) => void;
  onOpenFull: () => void;
}) {
  const t = useTranslations("transactions");
  const locale = useLocale();
  const onActionError = useActionErrorToast();
  // One key per opening (the content unmounts on close): a save sent again after a lost
  // answer carries the same one.
  const [requestRef] = useState(() => crypto.randomUUID());

  const [text, setText] = useState("");
  // An «M» the interpreter would not guess («3 M arriendo»), and which of its
  // two readings the person picked; a new token forgets the pick.
  const [ask, setAsk] = useState<AmountAsk | null>(null);
  const [pickedChoice, setPickedChoice] = useState<string>("");

  // Only accounts the person may write; the last-used one defaults only while on offer.
  const writableAccounts = options.accounts.filter((account) => account.canWrite);
  const lastUsedAccountId = writableAccounts.some(
    (account) => account.id === options.lastUsedAccountId,
  )
    ? options.lastUsedAccountId
    : null;

  const form = useForm<QuickEntryValues>({
    resolver: zodResolver(
      createTransactionSchema,
    ) as unknown as Resolver<QuickEntryValues>,
    mode: "onChange",
    defaultValues: {
      // Fixed to an expense: a source only, the destination always null (RF-18).
      fromAccountId: lastUsedAccountId,
      toAccountId: null,
      amount: "",
      // The account's own currency, and no control to change it: the quick
      // sheet records what the account already holds, and a movement in another
      // one carries a second amount the full form asks for (RF-121, RF-122).
      currency: accountCurrencyOf(options, lastUsedAccountId),
      counterAmount: null,
      counterIsEstimate: false,
      occurredAt: todayInBogota(),
      description: null,
      splits: [],
      labelIds: [],
    },
  });

  const fromAccountId = useWatch({ control: form.control, name: "fromAccountId" });
  const amount = useWatch({ control: form.control, name: "amount" });
  const currency = useWatch({ control: form.control, name: "currency" });
  const splits = useWatch({ control: form.control, name: "splits" });

  // The figure is read in whatever the chosen account settles in, so switching
  // account switches the reading with it.
  const accountCurrency = accountCurrencyOf(options, fromAccountId);

  // The account's scope decides which categories are on offer (RF-62): a
  // personal account names its owner, a group account its group.
  const scope = useMemo(() => {
    const account = options.accounts.find((one) => one.id === fromAccountId);
    return account?.groupId ? "group" : "personal";
  }, [options.accounts, fromAccountId]);

  // The expense set of that scope, parents and children flattened, is what the
  // interpreter matches a category token against.
  const expenseCategories = useMemo(
    () =>
      options.categories
        .filter((category) => category.scope === scope && category.kind === "expense")
        .flatMap((category) => [
          { id: category.id, name: category.name, kind: category.kind },
          ...category.children.map((child) => ({
            id: child.id,
            name: child.name,
            kind: "expense",
          })),
        ]),
    [options.categories, scope],
  );

  // The same scope's labels, offered only when it has any: the sheet stays as
  // short as it is today for a caller with none (RF-70).
  const scopedLabels = useMemo(
    () => options.labels.filter((label) => label.scope === scope),
    [options.labels, scope],
  );

  // The amount the interpreter last wrote into the field, so a later reading
  // with no amount can take back its own figure and leave a typed one alone.
  const proposedAmount = useRef<string | null>(null);

  // Everything the interpreter proposes stays a suggestion the fields may
  // overwrite (RF-22): the account fills only while still empty so a manual
  // pick survives further typing.
  function handleText(next: string) {
    setText(next);

    const proposal = interpretQuickEntry(next, {
      categories: expenseCategories,
      accounts: writableAccounts.map((one) => ({ id: one.id, name: one.name })),
      defaultAccountId: lastUsedAccountId,
    });

    if (proposal.ask?.token !== ask?.token) setPickedChoice("");
    setAsk(proposal.ask);

    if (proposal.amountPesos !== null) {
      // A reading that repeats the last proposal leaves a figure typed over it
      // alone: «1.500» then «1.500m» both read 1500.
      if (proposal.amountPesos !== proposedAmount.current) {
        form.setValue("amount", proposal.amountPesos, { shouldValidate: true });
        proposedAmount.current = proposal.amountPesos;
      }
    } else if (
      proposedAmount.current !== null &&
      form.getValues("amount") === proposedAmount.current
    ) {
      // «1.500» on its way to «1.500 mil» proposed 1500, and «3 M» on its way
      // to «3 M arriendo» 3 000 000; neither may outlive the text that proposed it.
      form.setValue("amount", "");
      proposedAmount.current = null;
    }
    if (proposal.accountId && !form.getValues("fromAccountId")) {
      form.setValue("fromAccountId", proposal.accountId, { shouldValidate: true });
    }
    form.setValue("description", proposal.description || null);
    if (proposal.categoryId) {
      // One category is one split summing to the amount (RF-69); more than one
      // is the split editor's to manage.
      form.setValue(
        "splits",
        [{ categoryId: proposal.categoryId, amount: proposal.amountPesos ?? "" }],
        { shouldValidate: true },
      );
    }
  }

  const lastScope = useRef(scope);

  // A lone split always carries the whole amount, so editing the total keeps it
  // in step; two or more are the editor's to balance.
  useEffect(() => {
    if (currency !== accountCurrency) {
      form.setValue("currency", accountCurrency, { shouldValidate: true });
    }

    if (splits.length === 1 && splits[0].amount !== amount) {
      form.setValue("splits", [{ ...splits[0], amount }], { shouldValidate: true });
    }

    // A label shares its movement's scope, so an account of the other scope
    // drops what the previous scope's picker filled.
    if (lastScope.current !== scope) {
      lastScope.current = scope;
      form.setValue("labelIds", [], { shouldValidate: true });
    }
  }, [amount, splits, scope, currency, accountCurrency, form]);

  const create = useAction(createTransactionAction, {
    onSuccess: ({ data }) => {
      const transactionId = data?.transactionId;
      // The undo toast stands in for a confirm dialog (RF-22): it removes the
      // movement just written.
      toast.success(t("saved"), {
        action: transactionId
          ? {
              label: t("undo"),
              onClick: () => remove.execute({ transactionId }),
            }
          : undefined,
      });
      onOpenChange(false);
    },
    onError: onActionError,
  });

  const remove = useAction(deleteTransactionAction, { onError: onActionError });

  // A picked reading is the person's own figure, not a proposal: further
  // typing that keeps the same question leaves it alone.
  function pickChoice(index: string) {
    if (!ask) return;
    setPickedChoice(index);
    proposedAmount.current = null;
    form.setValue("amount", amountToInput(ask.choices[Number(index)], accountCurrency), {
      shouldValidate: true,
    });
  }

  const hasAmount = amount.trim().length > 0;
  // Asked and still unanswered: neither a pick nor a typed figure yet.
  const awaitingPick = ask !== null && !hasAmount;
  // No token read into a figure or a category yet: prompt for both.
  const recognised = hasAmount || splits.some((split) => split.categoryId);
  const hint = text.trim().length === 0
    ? null
    : awaitingPick
      ? t("quickAskHint")
      : recognised
        ? t("quickInterpreted")
        : t("quickUnrecognized");

  function onSubmit(values: QuickEntryValues) {
    create.execute({ ...values, requestRef });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="quick-text">{t("quickTitle")}</FieldLabel>
          <TextField.Root
            id="quick-text"
            value={text}
            onChange={(event) => handleText(event.target.value)}
            placeholder={t("quickPlaceholder")}
            size="3"
            autoFocus
            autoComplete="off"
          >
            <TextField.Slot>
              <SquarePenIcon size={16} />
            </TextField.Slot>
          </TextField.Root>
          {hint && (
            <Text size="2" color={recognised && !awaitingPick ? "gray" : "amber"}>
              {hint}
            </Text>
          )}
        </Field>

        {ask && (
          <Field>
            <FieldLabel id="quick-ask-label">
              {t("quickAskQuestion", { token: ask.token })}
            </FieldLabel>
            <RadioCards.Root
              aria-labelledby="quick-ask-label"
              columns="2"
              size="1"
              value={pickedChoice}
              onValueChange={pickChoice}
              disabled={create.isPending}
            >
              {ask.choices.map((cents, index) => (
                <RadioCards.Item key={index} value={String(index)}>
                  {formatMoney(cents, accountCurrency, locale)}
                </RadioCards.Item>
              ))}
            </RadioCards.Root>
          </Field>
        )}

        <Controller
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="quick-amount">{t("amountLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="quick-amount"
                  size="3"
                  inputMode="numeric"
                  disabled={create.isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

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
                kind="expense"
                categories={options.categories}
                value={field.value}
                onChange={field.onChange}
              />
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        {scopedLabels.length > 0 && (
          <Controller
            name="labelIds"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldControl>
                  <ChipMultiSelect
                    id="quick-labels"
                    name="labelIds"
                    value={field.value}
                    onValueChange={field.onChange}
                    options={scopedLabels}
                    label={t("labelsLabel")}
                    disabled={create.isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {/* The two compact fields share a row from `md` up, as the artboard's
            field grid draws them; below it each keeps its own. */}
        <Flex direction={{ initial: "column", md: "row" }} gap="4" width="100%">
          <Controller
            name="fromAccountId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="quick-account">{t("accountLabel")}</FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value ?? undefined}
                  onValueChange={field.onChange}
                  disabled={create.isPending}
                >
                  <FieldControl>
                    <Select.Trigger
                      id="quick-account"
                      placeholder={t("accountLabel")}
                    />
                  </FieldControl>
                  <Select.Content position="popper">
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
            name="occurredAt"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="quick-date">{t("dateLabel")}</FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="quick-date"
                    size="3"
                    type="date"
                    disabled={create.isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        </Flex>

        <Flex justify="center">
          <Link href="#" onClick={(event) => { event.preventDefault(); onOpenFull(); }}>
            {/* A line of text has no control height of its own. */}
            <TapTarget align="center" px="2">
              {t("quickTypeLink")}
            </TapTarget>
          </Link>
        </Flex>

        {/* Never dead while the form is short of something: submitting is what
            makes it say so. An unanswered question is the one exception, since
            the hint already says what is missing (RF-22). */}
        <Button type="submit" size="3" disabled={create.isPending || awaitingPick}>
          {create.isPending && <Spinner />}
          {t("quickSave")}
        </Button>
      </FieldGroup>
    </form>
  );
}
