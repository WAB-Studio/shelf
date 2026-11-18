"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronLeftIcon, InfoIcon, SquarePenIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Controller,
  useForm,
  useWatch,
  type Resolver,
} from "react-hook-form";

import { deferPurchaseAction } from "@/app/actions/deferrals";
import {
  createTransactionAction,
  deleteTransactionAction,
  updateTransactionAction,
} from "@/app/actions/transactions";
import { acceptDeliveryAction } from "@/app/actions/ingest";
import { proposeRateAction } from "@/app/actions/rates";
import { AccountFormDialog } from "@/components/accounts/account-form-dialog";
import { StartedEarlierOffer } from "@/components/accounts/started-earlier-offer";
import { SplitEditor } from "@/components/transactions/split-editor";
import {
  Badge,
  Box,
  Button,
  Callout,
  ChipMultiSelect,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Figure,
  Flex,
  FundChip,
  Grid,
  Heading,
  IconButton,
  RadioCards,
  Select,
  Spinner,
  StackedSegmentedControl,
  Switch,
  TapTarget,
  Text,
  TextField,
  type Responsive,
  AmountField,
  DateInput,
} from "@/components/ui";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import type { TransactionListRow } from "@/db/queries/transactions";
import {
  BASE_CURRENCY,
  type CurrencyCode,
  isOfferedCurrency,
  OFFERED_CURRENCIES,
} from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { PocketNotice, usePocketList } from "@/components/transactions/pocket-notice";
import { readCover } from "@/lib/pocket-cover";
import { interpretQuickEntry, type AmountAsk } from "@/lib/transactions/interpret";
import { amountToInput, convertMinor, deriveRate, parseAmount } from "@/lib/money";
import { useMoneyText } from "@/lib/use-privacy";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { toast } from "sonner";
import {
  acceptDeliverySchema,
  type AcceptDeliveryInput,
} from "@/lib/validation/ingest";
import {
  createTransactionSchema,
  foreignSettlementCurrency,
  asksContributor,
  refineContributor,
  refineSettlement,
  updateTransactionSchema,
  type CreateTransactionInput,
  type SettlementCurrencies,
  type SplitFields,
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
  forHousehold: boolean;
  contributedByMemberId: string | null;
  madeByMemberId: string | null;
  occurredAt: string;
  description: string | null;
  externalRef?: string;
  splits: SplitFields[];
  labelIds: string[];
  forPersonId: string | null;
  causedByTransactionId: string | null;
};

// The three tabs, which say where the money goes; the database still derives the kind from the two account
// slots the tab fills (RF-272): a lone destination is an income, a lone source an expense, both a transfer.
export type MovementTab = "expense" | "income" | "transfer";

function tabOf(fromAccountId: string | null, toAccountId: string | null): MovementTab {
  if (fromAccountId && toAccountId) return "transfer";
  if (toAccountId) return "income";
  return "expense";
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
  dateBeforeOpening,
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
    // The tab it opens on when the sides alone do not say it: a Bandeja card that proposed an income with no account
    // yet still opens on «Ingreso».
    tab?: MovementTab;
    fromAccountId?: string | null;
    toAccountId?: string | null;
    amount?: string;
    occurredAt?: string;
    description?: string | null;
    splits?: SplitFields[];
    // The person picked on the Bandeja card before opening the form (RF-242).
    forPersonId?: string | null;
  };
  // A notice dated before its account opened: the form opens with the refusal already beside the
  // date, which is brought into view.
  dateBeforeOpening?: boolean;
  // Runs on a stored write only; `onDone` also runs on the back button.
  onSaved?: () => void;
  onDone: () => void;
}) {
  const moneyText = useMoneyText();
  const t = useTranslations("transactions");
  const tIngest = useTranslations("ingest");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const onActionError = useActionErrorToast();
  // One key per opening: a save sent again after a lost answer carries the same one, and the
  // form unmounts on close, so the next opening mints its own.
  const [requestRef] = useState(() => crypto.randomUUID());
  const [refusal, setRefusal] = useState<"errors.stale" | "errors.resendChanged" | null>(null);

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

  // A bare form opens as an expense from the last-used account; a caller that names either side opens on the
  // tab those sides make (RF-272).
  const namesSides =
    defaults !== undefined &&
    (defaults.fromAccountId !== undefined || defaults.toAccountId !== undefined);
  const openingFrom = movement
    ? movement.fromAccountId
    : namesSides
      ? (defaults?.fromAccountId ?? null)
      : lastUsedAccountId;
  const openingTo = movement ? movement.toAccountId : namesSides ? (defaults?.toAccountId ?? null) : null;
  const openingAccountId = openingFrom ?? openingTo;

  const [tab, setTab] = useState<MovementTab>(() => defaults?.tab ?? tabOf(openingFrom, openingTo));
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  // The settlement rules need what each named account settles in, and the values
  // under validation name the accounts: the resolver reads the pair off them and
  // refines the mode's own schema with it, so the form refuses exactly what the
  // action refuses against the currencies it reads back (RNF-10).
  const intoFundAccount = (accountId: string | null) =>
    options.accounts.some((account) => account.id === accountId && account.groupId !== null);

  const resolver: Resolver<MovementFormValues> = (values, context, options_) => {
    const schema = (
      isEdit
        ? updateTransactionSchema
        : isAccept
          ? acceptDeliverySchema
          : createTransactionSchema
    )
      .superRefine(
        refineSettlement(
          settlementOf(
            options.accountCurrencies,
            values.fromAccountId,
            values.toAccountId,
          ),
        ),
      )
      .superRefine(
        // A delivery accepted from the inbox may stay unassigned, as its one tap does.
        refineContributor(!isAccept && intoFundAccount(values.toAccountId)),
      )
      .superRefine((data, ctx) => {
        // The tab says which sides the person must fill; the schema alone would take a transfer with one side
        // as an expense.
        const needsFrom = tab !== "income";
        const needsTo = tab !== "expense";
        if (needsFrom && !data.fromAccountId) {
          ctx.addIssue({ code: "custom", message: "transactions.errors.accountRequired", path: ["fromAccountId"] });
        }
        if (needsTo && !data.toAccountId) {
          ctx.addIssue({
            code: "custom",
            message: tab === "transfer" ? "transactions.errors.transferNeedsTarget" : "transactions.errors.accountRequired",
            path: ["toAccountId"],
          });
        }
      });

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
          amount: amountToInput(movement.amountCents, movement.currency, locale),
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
                  locale,
                ),
          counterIsEstimate: movement.counterIsEstimate,
          forHousehold: movement.forHousehold,
          contributedByMemberId: movement.contributedByMemberId,
          madeByMemberId: movement.madeByMemberId,
          occurredAt: movement.occurredAt,
          description: movement.description,
          splits: movement.splits.map((split) => ({
            categoryId: split.categoryId,
            amount: amountToInput(split.amountCents, movement.currency, locale),
            description: split.description,
          })),
          labelIds: movement.labels.map((label) => label.id),
          forPersonId: movement.forPerson?.id ?? null,
          causedByTransactionId,
        }
      : {
          deliveryId: isAccept ? deliveryId : undefined,
          fromAccountId: openingFrom,
          toAccountId: openingTo,
          amount: defaults?.amount ?? "",
          currency:
            (openingAccountId && options.accountCurrencies[openingAccountId]) ??
            BASE_CURRENCY,
          counterAmount: null,
          counterIsEstimate: false,
          forHousehold: false,
          contributedByMemberId: null,
          madeByMemberId: null,
          occurredAt: defaults?.occurredAt ?? todayInBogota(),
          description:
            defaults?.description !== undefined ? defaults.description : null,
          splits: defaults?.splits ?? [],
          labelIds: [],
          forPersonId: defaults?.forPersonId ?? null,
          causedByTransactionId,
        },
  });

  // The day refused as earlier than an account's opening: the offer to begin the account earlier shows under it for
  // as long as the date is still that one. A delivery the Bandeja flagged arrives already refused.
  const [refusedDay, setRefusedDay] = useState<string | null>(() => (dateBeforeOpening ? form.getValues("occurredAt") : null));

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
  const forHouseholdMark = useWatch({ control: form.control, name: "forHousehold" });
  // Errors wait for a submit attempt: an untouched form is not a wrong one.
  const submitted = form.formState.isSubmitted;

  const kind: MovementTab = tab;

  // The tab decides which account slots are filled; switching keeps the amount, the words and the date, and
  // carries the account over to the slot the new tab asks for (RF-272).
  function switchTab(next: string) {
    if (next === tab || (next !== "expense" && next !== "income" && next !== "transfer")) return;
    const primary =
      tab === "income"
        ? (toAccountId ?? fromAccountId)
        : (fromAccountId ?? toAccountId);
    setTab(next);
    form.setValue("fromAccountId", next === "income" ? null : primary);
    form.setValue("toAccountId", next === "income" ? primary : null);
    form.clearErrors(["fromAccountId", "toAccountId"]);
  }

  // The phrase is read only on a fresh entry: an edit or a delivery's proposal keeps the words it has.
  const readsPhrase = !isEdit && !isAccept;
  // An «M» the interpreter would not guess, or a figure whose marks could be read two ways, and which of its
  // readings the person picked; a new token forgets the pick.
  const [ask, setAsk] = useState<AmountAsk | null>(null);
  const [pickedChoice, setPickedChoice] = useState("");
  const [phraseSeen, setPhraseSeen] = useState(false);
  const [instalments, setInstalments] = useState("");
  // What the interpreter last wrote into a field, so a later reading can take back its own proposal and leave
  // what the person typed over it alone.
  const proposedAmount = useRef<string | null>(null);
  const pickedAmount = useRef<string | null>(null);
  const proposedDate = useRef<string | null>(null);
  const proposedCategory = useRef<string | null>(null);
  const proposedInstalments = useRef<string | null>(null);
  const proposedCurrency = useRef<string | null>(null);
  // The figure read from words, which «Revisar el mes» asks about (RF-155).
  const [wordsAmount, setWordsAmount] = useState<string | null>(null);

  // A new account (made from this very form) fills the empty slot, so the draft goes on where it stopped.
  const accountCount = useRef(writableAccounts.length);
  useEffect(() => {
    const before = accountCount.current;
    accountCount.current = writableAccounts.length;
    if (before !== 0 || writableAccounts.length === 0 || fromAccountId || toAccountId) return;
    const first = writableAccounts[0].id;
    form.setValue(tab === "income" ? "toAccountId" : "fromAccountId", first, { shouldValidate: true });
  }, [writableAccounts, fromAccountId, toAccountId, tab, form]);

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
  // «Del hogar» (RF-139) is offered on an expense from a personal account to a person who has a fund,
  // and stays on a movement that already carries it, so a mark can always be cleared.
  const offersHousehold =
    kind === "expense" &&
    scope === "personal" &&
    (movement?.forHousehold === true || options.accounts.some((one) => one.groupId));

  // «De quién» (RF-167) is asked of an income into a fund account, and nowhere else. It opens
  // empty: a refund or a gift from someone else is no one's aporte, and a guess would credit it.
  const offersContributor = asksContributor(
    { fromAccountId, toAccountId },
    intoFundAccount(toAccountId),
  );

  // «Lo hizo» (RF-182) is asked of a fund movement: one touching a fund account, or a household bill.
  const offersMadeBy =
    intoFundAccount(fromAccountId) ||
    intoFundAccount(toAccountId) ||
    (offersHousehold && forHouseholdMark);

  // A movement is never its own cause (RF-132), so the movement under edit is
  // dropped from what the picker offers; the rest arrive already ordered.
  const causeCandidates = useMemo(
    () => causeOptions.filter((row) => row.id !== movement?.id),
    [causeOptions, movement?.id],
  );

  // A movement's labels share its scope, so only that scope's set is on offer
  // (RF-70); the other scope's would be refused by the check on write.
  const scopedLabels = useMemo(
    () => options.labels.filter((label) => label.scope === scope && label.kind === "tag"),
    [options.labels, scope],
  );
  // «Para quién» is a person of the same scope (RF-242), offered beside the tags.
  const scopedPersons = useMemo(
    () => options.labels.filter((label) => label.scope === scope && label.kind === "person"),
    [options.labels, scope],
  );
  const forPersonId = useWatch({ control: form.control, name: "forPersonId" });
  const occurredAt = useWatch({ control: form.control, name: "occurredAt" });
  const chargedPerson = scopedPersons.find((person) => person.id === forPersonId)?.chargeDefault ?? false;

  // The categories the phrase may name: the tab's kind in the account's scope, parents and children flattened.
  const phraseCategories = useMemo(
    () =>
      kind === "transfer"
        ? []
        : options.categories
            .filter((category) => category.scope === scope && category.kind === kind)
            .flatMap((category) => [
              { id: category.id, name: category.name, kind: category.kind },
              ...category.children.map((child) => ({ id: child.id, name: child.name, kind: category.kind })),
            ]),
    [options.categories, scope, kind],
  );
  // What the person already filed under a category, newest first: tried before the common names (RF-273).
  const phraseMemory = useMemo(
    () =>
      options.recentMovements.flatMap((row) =>
        row.kind === kind && row.description && row.splits.length === 1
          ? [{ text: row.description, categoryId: row.splits[0].categoryId }]
          : [],
      ),
    [options.recentMovements, kind],
  );

  // The words are saved as typed, less the figures they gave to the fields. They also propose: the figure, the day, the category, the account and the
  // instalments, each of which stays a suggestion the fields may overwrite (RF-273).
  function interpretPhrase(text: string) {
    return interpretQuickEntry(text, {
      categories: phraseCategories,
      accounts: kind === "transfer" ? [] : writableAccounts.map((one) => ({ id: one.id, name: one.name })),
      defaultAccountId: null,
      today: todayInBogota(),
      memory: phraseMemory,
    });
  }

  function readPhrase(text: string) {
    const proposal = interpretPhrase(text);

    if (proposal.ask?.token !== ask?.token) {
      setPickedChoice("");
      setWordsAmount(null);
      if (pickedAmount.current !== null && form.getValues("amount") === pickedAmount.current) {
        form.setValue("amount", "");
      }
      pickedAmount.current = null;
    }
    setAsk(proposal.ask);

    if (proposal.amountPesos !== null) {
      // A reading that repeats the last proposal leaves a figure typed over it alone.
      if (proposal.amountPesos !== proposedAmount.current) {
        form.setValue("amount", proposal.amountPesos, { shouldValidate: true });
        proposedAmount.current = proposal.amountPesos;
      }
      setWordsAmount(proposal.amountFromWords ? proposal.amountPesos : null);
    } else if (proposedAmount.current !== null && form.getValues("amount") === proposedAmount.current) {
      form.setValue("amount", "");
      proposedAmount.current = null;
      setWordsAmount(null);
    }

    const sideField = kind === "income" ? "toAccountId" : "fromAccountId";
    if (kind !== "transfer" && proposal.accountId && !form.getValues(sideField)) {
      form.setValue(sideField, proposal.accountId, { shouldValidate: true });
    }

    const date = form.getValues("occurredAt");
    if (proposal.occurredAt !== null) {
      if (proposal.occurredAt !== proposedDate.current) {
        form.setValue("occurredAt", proposal.occurredAt, { shouldValidate: true });
        proposedDate.current = proposal.occurredAt;
      }
    } else if (proposedDate.current !== null && date === proposedDate.current) {
      form.setValue("occurredAt", todayInBogota(), { shouldValidate: true });
      proposedDate.current = null;
    }

    // A currency said in words («15,99 dólares») moves the field; taking the word out gives the account's own
    // back. A code the selector does not offer («euros») is left to the person.
    const wantedCurrency = proposal.currency !== null && isOfferedCurrency(proposal.currency) ? proposal.currency : null;
    if (wantedCurrency !== null) {
      if (wantedCurrency !== proposedCurrency.current) {
        form.setValue("currency", wantedCurrency, { shouldValidate: true });
        proposedCurrency.current = wantedCurrency;
      }
    } else if (proposedCurrency.current !== null) {
      if (form.getValues("currency") === proposedCurrency.current) {
        form.setValue("currency", accountCurrency ?? BASE_CURRENCY, { shouldValidate: true });
      }
      proposedCurrency.current = null;
    }

    const wantedInstalments = proposal.instalments === null ? null : String(proposal.instalments);
    if (wantedInstalments !== null) {
      if (wantedInstalments !== proposedInstalments.current) {
        setInstalments(wantedInstalments);
        proposedInstalments.current = wantedInstalments;
      }
    } else if (proposedInstalments.current !== null && instalments === proposedInstalments.current) {
      setInstalments("");
      proposedInstalments.current = null;
    }

    // One category is one split summing to the amount (RF-69); more than one is the split editor's. A
    // category the person picked by hand is not taken back.
    const current = form.getValues("splits");
    const pickedByHand =
      current.length > 1 ||
      (current[0]?.categoryId && current[0].categoryId !== proposedCategory.current);
    if (kind !== "transfer" && proposal.categoryId && !pickedByHand) {
      form.setValue(
        "splits",
        [{ categoryId: proposal.categoryId, amount: proposal.amountPesos ?? form.getValues("amount") }],
        { shouldValidate: true },
      );
      proposedCategory.current = proposal.categoryId;
    } else if (!proposal.categoryId && proposedCategory.current !== null && !pickedByHand) {
      form.setValue("splits", [{ categoryId: "", amount: form.getValues("amount") }]);
      proposedCategory.current = null;
    }
  }

  // A picked reading is the person's own figure, not a proposal: further typing that keeps the same question
  // leaves it alone.
  function pickChoice(index: string) {
    if (!ask) return;
    setPickedChoice(index);
    proposedAmount.current = null;
    const choice = ask.choices[Number(index)];
    const picked = amountToInput(choice.cents, accountCurrency ?? BASE_CURRENCY, locale);
    pickedAmount.current = picked;
    setWordsAmount(choice.fromWords ? picked : null);
    form.setValue("amount", picked, { shouldValidate: true });
  }

  // What the database will draw from the account's pockets for this movement (RF-249), said before saving
  // (RF-276). Only a fresh entry: an edit reads its figures again on the server.
  const pocketPlan = useMemo(() => {
    if (isEdit || isAccept || kind === "income") return null;
    return readCover({
      accounts: options.accounts,
      fromAccountId,
      toAccountId,
      amountCents: parseAmount(amount),
      currency,
      occurredOn: occurredAt,
    }).plan;
  }, [isEdit, isAccept, kind, options.accounts, fromAccountId, toAccountId, amount, currency, occurredAt]);

  const pocketList = usePocketList(pocketPlan, currency);

  // A card purchase may be split into instalments from the same form (RF-136, RF-273): the movement is
  // written first and then deferred, so the balance never changes.
  const fromAccount = options.accounts.find((one) => one.id === fromAccountId);
  const offersInstalments = readsPhrase && kind === "expense" && fromAccount?.subtype === "card";

  // Keep the splits in step with the derived kind: a transfer drops them, and a
  // switch between income and expense clears the categories the old kind carried
  // (RF-69). A lone split always holds the whole amount, like the quick sheet.
  const lastKind = useRef<MovementTab | null>(kind);
  const lastTotal = useRef(amount);
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
    } else if (
      splits.length === 1 &&
      splits[0].amount !== amount &&
      splits[0].amount === lastTotal.current
    ) {
      // A lone line follows the total until the person types its own figure (RF-275); after that the gap
      // shows, and a second line takes the rest.
      form.setValue("splits", [{ ...splits[0], amount }], { shouldValidate: true });
    }

    lastTotal.current = amount;
    lastKind.current = kind;
  }, [kind, splits, amount, form]);

  // Switching to an account of the other scope drops the selection, so a
  // personal label never rides into a group movement.
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    form.setValue("labelIds", [], { shouldValidate: true });
    form.setValue("forPersonId", null, { shouldValidate: true });
  }, [scope, form]);

  function onActionSuccess() {
    onSaved?.();
    onDone();
  }

  // Three hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  // A date before the account's opening is also written beside the date, with what was typed kept.
  function refuseDate(result: { error: { serverError?: string } }) {
    onActionError(result);
    form.setError("occurredAt", { type: "server", message: "errors.movementBeforeOpening" });
    setRefusedDay(form.getValues("occurredAt"));
  }

  useEffect(() => {
    if (!dateBeforeOpening) return;
    form.setError("occurredAt", { type: "server", message: "errors.movementBeforeOpening" });
    // After the dialog has taken its own initial focus.
    const timer = setTimeout(() => {
      const input = document.getElementById("movement-date");
      input?.scrollIntoView({ block: "center" });
      input?.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [dateBeforeOpening, form]);

  const remove = useAction(deleteTransactionAction, { onError: onActionError });
  const defer = useAction(deferPurchaseAction, { onError: onActionError });
  const create = useAction(createTransactionAction, {
    onError: (result) => {
      if (result.error.serverError === "errors.resendChanged") setRefusal("errors.resendChanged");
      else if (result.error.serverError === "errors.movementBeforeOpening") refuseDate(result);
      else onActionError(result);
    },
  });
  const update = useAction(updateTransactionAction, {
    onSuccess: onActionSuccess,
    onError: (result) => {
      if (result.error.serverError === "errors.stale") setRefusal("errors.stale");
      else if (result.error.serverError === "errors.movementBeforeOpening") refuseDate(result);
      else onActionError(result);
    },
  });
  const accept = useAction(acceptDeliveryAction, {
    onSuccess: onActionSuccess,
    onError: (result) => {
      if (result.error.serverError === "errors.movementBeforeOpening") refuseDate(result);
      else onActionError(result);
    },
  });

  const isPending = isEdit
    ? update.isPending
    : isAccept
      ? accept.isPending
      : create.isPending;

  function onSubmit(submitted: MovementFormValues) {

    // A switch hidden by a change of account never sends a mark the person no longer sees.
    const values = {
      ...submitted,
      forHousehold: offersHousehold && submitted.forHousehold,
      contributedByMemberId: offersContributor ? submitted.contributedByMemberId : null,
      madeByMemberId: offersMadeBy ? submitted.madeByMemberId : null,
    };
    // The resolver already parsed `values` for this mode, dropping the field the
    // other mode's action refuses: `external_ref` on edit, `transaction_id` on
    // create.
    if (isEdit) {
      setRefusal(null);
      update.execute({
        ...(values as UpdateTransactionInput),
        expectedUpdatedAt: movement?.updatedAt,
      });
    } else if (isAccept) {
      accept.execute({ ...values, deliveryId } as AcceptDeliveryInput);
    } else {
      if (instalmentsInvalid) return;
      const count = offersInstalments ? instalmentsCount : null;
      const list = pocketList;
      // The figure, the day, the currency and the instalments the phrase gave to their fields leave the description.
      const typed = (values.description ?? "").trim();
      const description = typed === "" ? null : interpretPhrase(typed).phrase || null;
      void create
        .executeAsync({
          ...(values as CreateTransactionInput),
          description,
          requestRef,
          amountFromWords: values.amount === wordsAmount,
        })
        .then((result) => {
          const transactionId = result?.data?.transactionId;
          if (!transactionId) return;
          if (count !== null) defer.execute({ transactionId, instalments: count });
          // The toast stands in for a confirm dialog: «Deshacer» removes what was just written, and with it
          // what the database drew from a pocket (RF-249, RF-276).
          toast.success(list ? t("savedPocket", { list }) : t("saved"), {
            action: { label: t("undo"), onClick: () => remove.execute({ transactionId }) },
          });
          onActionSuccess();
        });
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
    return `${name} · ${day} · ${moneyText(row.amountCents, row.currency, locale)}`;
  }

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
        amountToInput(convertMinor(amountMinor, data.rate), foreign, locale),
        { shouldValidate: true },
      );
    },
    onError: () => setRateUnavailable(true),
  });

  function handleSuggestRate() {
    if (foreign === null || amountMinor === null || amountMinor <= 0) return;
    proposeRate.execute({ from: currency, to: foreign });
  }

  const noAccounts = readsPhrase && writableAccounts.length === 0;
  const instalmentsCount = instalments.trim() === "" ? null : Number(instalments);
  const instalmentsInvalid =
    offersInstalments && instalmentsCount !== null && !(instalmentsCount >= 2 && instalmentsCount <= 72);
  // A figure as a person writes it, thousands grouped and cents only when there are some: «12.000,50».
  function groupedFigure(cents: number): string {
    const rest = cents % 100;
    const mark = locale.startsWith("en") ? "." : ",";
    return `${format.number(Math.trunc(cents / 100))}${rest === 0 ? "" : `${mark}${String(rest).padStart(2, "0")}`}`;
  }
  const hasAmount = amount.trim().length > 0;
  // Asked and still unanswered: neither a pick nor a typed figure yet.
  const awaitingPick = ask !== null && !hasAmount;
  const description = useWatch({ control: form.control, name: "description" });
  const recognised = hasAmount || splits.some((split) => split.categoryId);
  const hint =
    !readsPhrase || !phraseSeen || !(description ?? "").trim()
      ? null
      : awaitingPick
        ? t("quickAskHint")
        : recognised
          ? t("quickInterpreted")
          : t("quickUnrecognized");

  const accountSelect = (
    name: "fromAccountId" | "toAccountId",
    id: string,
    label: string,
    mark: string | null,
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Select.Root
            size="3"
            value={field.value ?? undefined}
            onValueChange={field.onChange}
            disabled={isPending}
          >
            <FieldControl>
              <Select.Trigger id={id} placeholder={mark ?? t("accountPlaceholder")} />
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
  );

  return (
    <>
      <form
        onSubmit={(event) => {
          // With no account at all, saving is the way to the account that is missing: the draft stays.
          if (noAccounts) {
            event.preventDefault();
            setAccountDialogOpen(true);
            return;
          }
          void form.handleSubmit(onSubmit)(event);
        }}
        noValidate
      >
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

        {/* The amount reads in the tab's sign and colour. */}
        <Flex direction="column" align="center" gap="2" mb="4">
          <Figure as="h1" size="8" color={kindColor}>
            {`${sign}${moneyText(amountMinor ?? 0, currency, locale)}`}
          </Figure>
        </Flex>

        {/* Where the money goes: three tabs that keep the amount, the words and the date (RF-272). */}
        <Flex mb="5" justify="center">
          <StackedSegmentedControl.Root wrap value={tab} onValueChange={switchTab}>
            <StackedSegmentedControl.Item value="expense">{t("kindExpense")}</StackedSegmentedControl.Item>
            <StackedSegmentedControl.Item value="income">{t("kindIncome")}</StackedSegmentedControl.Item>
            <StackedSegmentedControl.Item value="transfer">{t("kindTransfer")}</StackedSegmentedControl.Item>
          </StackedSegmentedControl.Root>
        </Flex>

        {/* The artboard's body from `md` up: the words, the figure and the accounts on the fixed track, the
            splits and the labels on what is left. Below `md` it is one column. */}
        <Grid
          columns={{ initial: "1", md: BODY_COLUMNS }}
          gap="5"
          align="start"
          width="100%"
        >
          <FieldGroup>
            {/* What the person writes is what is saved; on a fresh entry it also proposes the rest (RF-273). */}
            <Controller
              name="description"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="movement-description">
                    <Flex as="span" align="center" gap="1">
                      {t("descriptionLabel")}
                      <Text size="2" weight="regular" color="gray">
                        {tKey("common.optional")}
                      </Text>
                    </Flex>
                  </FieldLabel>
                  <FieldControl>
                    <TextField.Root
                      id="movement-description"
                      size="3"
                      autoComplete="off"
                      autoFocus={readsPhrase}
                      placeholder={readsPhrase ? t("descriptionPlaceholder") : undefined}
                      disabled={isPending}
                      value={field.value ?? ""}
                      onChange={(event) => {
                        field.onChange(event.target.value || null);
                        if (readsPhrase) {
                          setPhraseSeen(true);
                          readPhrase(event.target.value);
                        }
                      }}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    >
                      {readsPhrase && (
                        <TextField.Slot>
                          <SquarePenIcon size={16} />
                        </TextField.Slot>
                      )}
                    </TextField.Root>
                  </FieldControl>
                  {hint && (
                    <Text size="2" color={recognised && !awaitingPick ? "gray" : "amber"}>
                      {hint}
                    </Text>
                  )}
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />

            {ask && (
              <Field>
                <FieldLabel id="movement-ask-label">
                  {ask.marks
                    ? t("quickAskMarks", {
                        first: groupedFigure(ask.choices[0].cents),
                        second: groupedFigure(ask.choices[1].cents),
                      })
                    : t("quickAskQuestion", { token: ask.token })}
                </FieldLabel>
                <RadioCards.Root
                  aria-labelledby="movement-ask-label"
                  columns="2"
                  size="1"
                  value={pickedChoice}
                  onValueChange={pickChoice}
                  disabled={isPending}
                >
                  {ask.choices.map(({ cents }, index) => (
                    <RadioCards.Item key={index} value={String(index)}>
                      {ask.marks
                        ? `$ ${groupedFigure(cents)}`
                        : moneyText(cents, accountCurrency ?? BASE_CURRENCY, locale)}
                    </RadioCards.Item>
                  ))}
                </RadioCards.Root>
              </Field>
            )}

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
                        <AmountField
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

            {noAccounts ? (
              <Flex direction="column" gap="3" align="start">
                <Callout.Root color="amber" variant="soft">
                  <Callout.Icon>
                    <InfoIcon size={16} />
                  </Callout.Icon>
                  <Callout.Text>{t("noAccounts")}</Callout.Text>
                </Callout.Root>
                <Button type="button" size="3" variant="soft" onClick={() => setAccountDialogOpen(true)}>
                  {t("createAccount")}
                </Button>
              </Flex>
            ) : kind === "expense" ? (
              accountSelect("fromAccountId", "movement-from", t("accountLabel"), null)
            ) : kind === "income" ? (
              accountSelect("toAccountId", "movement-to", t("accountLabel"), null)
            ) : (
              <>
                {accountSelect("fromAccountId", "movement-from", t("fromLabel"), null)}
                {accountSelect("toAccountId", "movement-to", t("toLabel"), null)}
              </>
            )}

            {pocketList && <PocketNotice list={pocketList} />}

            {offersInstalments && (
              <Field invalid={submitted && instalmentsInvalid}>
                <FieldLabel htmlFor="movement-instalments">
                  <Flex as="span" align="center" gap="1">
                    {t("instalmentsLabel")}
                    <Text size="2" weight="regular" color="gray">
                      {tKey("common.optional")}
                    </Text>
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="movement-instalments"
                    size="3"
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={isPending}
                    value={instalments}
                    onChange={(event) => {
                      setInstalments(event.target.value.replace(/\D/g, ""));
                      proposedInstalments.current = null;
                    }}
                  />
                </FieldControl>
                <FieldDescription>{t("instalmentsHint")}</FieldDescription>
                {submitted && instalmentsInvalid && (
                  <FieldMessage error={{ type: "custom", message: "deferrals.errors.instalmentsInvalid" }} />
                )}
              </Field>
            )}

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
                          <AmountField
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
                  // Destructured here, ahead of the submit gate: a field that never reads its error is never told it changed.
                  render={({ field, fieldState: { invalid, error } }) => (
                    <Field invalid={submitted && invalid}>
                      <FieldLabel>{t("categoryLabel")}</FieldLabel>
                      <SplitEditor
                        total={amount}
                        currency={currency}
                        scope={scope}
                        kind={kind}
                        categories={options.categories}
                        frequentIds={options.frequentCategoryIds}
                        value={field.value}
                        onChange={field.onChange}
                      />
                      <FieldMessage error={submitted ? error : undefined} />
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

              {/* Whom it was for: still the person's own expense, so it asks for nothing more (RF-242). On an income it is
                  who sent the money back, which lowers what they owe (RF-293). */}
              {scopedPersons.length > 0 && (
                <Controller
                  name="forPersonId"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="movement-for-person">
                        <Flex as="span" align="center" gap="1">
                          {t(kind === "income" ? "fromPersonLabel" : "forPersonLabel")}
                          <Text size="2" weight="regular" color="gray">
                            {tKey("common.optional")}
                          </Text>
                        </Flex>
                      </FieldLabel>
                      <Select.Root
                        size="3"
                        value={field.value ?? NO_ACCOUNT}
                        onValueChange={(value) => field.onChange(value === NO_ACCOUNT ? null : value)}
                        disabled={isPending}
                      >
                        <FieldControl>
                          <Select.Trigger id="movement-for-person" />
                        </FieldControl>
                        <Select.Content position="popper">
                          <Select.Item value={NO_ACCOUNT}>{t("forPersonNone")}</Select.Item>
                          {scopedPersons.map((person) => (
                            <Select.Item key={person.id} value={person.id}>
                              {person.name}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Root>
                      {chargedPerson && (
                        <FieldDescription>{t(kind === "income" ? "fromPersonCharged" : "forPersonCharged")}</FieldDescription>
                      )}
                      <FieldMessage error={fieldState.error} />
                    </Field>
                  )}
                />
              )}
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
                    <DateInput
                      {...field}
                      id="movement-date"
                      size="3"
                      disabled={isPending}
                    />
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />

            {refusedDay !== null && refusedDay === occurredAt && (
              <StartedEarlierOffer
                accountIds={[fromAccountId, toAccountId].filter((id): id is string => Boolean(id))}
                occurredAt={occurredAt}
                onMoved={() => {
                  setRefusedDay(null);
                  form.clearErrors("occurredAt");
                  void form.handleSubmit(onSubmit)();
                }}
              />
            )}

            {offersHousehold && (
              <Controller
                name="forHousehold"
                control={form.control}
                render={({ field }) => (
                  <Text as="label" size="2">
                    <TapTarget align="center" gap="2">
                      <Switch
                        checked={field.value}
                        disabled={isPending}
                        onCheckedChange={field.onChange}
                      />
                      <Flex direction="column">
                        {t("forHousehold")}
                        <Text size="1" color="gray">
                          {t("forHouseholdHint")}
                        </Text>
                      </Flex>
                    </TapTarget>
                  </Text>
                )}
              />
            )}
            {offersContributor && (
              <Controller
                name="contributedByMemberId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="movement-contributor">{t("contributorLabel")}</FieldLabel>
                    <Select.Root
                      size="3"
                      value={field.value ?? (isAccept ? NO_ACCOUNT : undefined)}
                      onValueChange={(value) =>
                        field.onChange(value === NO_ACCOUNT ? null : value)
                      }
                      disabled={isPending}
                    >
                      <FieldControl>
                        <Select.Trigger
                          id="movement-contributor"
                          placeholder={t("contributorPlaceholder")}
                        />
                      </FieldControl>
                      <Select.Content position="popper">
                        {isAccept && (
                          <Select.Item value={NO_ACCOUNT}>{t("contributorNone")}</Select.Item>
                        )}
                        {options.fundMembers.map((member) => (
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
            )}
            {offersMadeBy && (
              <Controller
                name="madeByMemberId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="movement-made-by">{t("madeByLabel")}</FieldLabel>
                    <Select.Root
                      size="3"
                      value={field.value ?? NO_ACCOUNT}
                      onValueChange={(value) => field.onChange(value === NO_ACCOUNT ? null : value)}
                      disabled={isPending}
                    >
                      <FieldControl>
                        <Select.Trigger id="movement-made-by" />
                      </FieldControl>
                      <Select.Content position="popper">
                        <Select.Item value={NO_ACCOUNT}>{t("madeByNone")}</Select.Item>
                        {[
                          ...options.fundMembers,
                          ...options.formerMembers.filter((member) => member.id === field.value),
                        ].map((member) => (
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
            )}
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
              {refusal && (
                <Callout.Root color="red" variant="soft" role="alert">
                  <Callout.Icon>
                    <InfoIcon size={16} />
                  </Callout.Icon>
                  <Callout.Text>{tKey(refusal)}</Callout.Text>
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
      {/* Outside the form: a submit inside the account's own dialog must never save this movement. */}
      {readsPhrase && (
        <AccountFormDialog
          hasGroup={options.fundMembers.length > 0}
          open={accountDialogOpen}
          onOpenChange={setAccountDialogOpen}
        />
      )}
    </>
  );
}
