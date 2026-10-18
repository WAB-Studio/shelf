import { z } from "zod";

import {
  BASE_CURRENCY,
  type CurrencyCode,
  OFFERED_CURRENCIES,
} from "@/lib/currency";
import { isCivilDate, todayInBogota } from "@/lib/dates";
import { maxAmountMinor, parseAmount } from "@/lib/money";

// A peso string travels through validation unparsed: the amount stays a
// string the form owns until the action turns it into integer cents. Exported
// so every money field across the ledger, budgets and goals shares one parse.
//
// Reads through `parseAmount`, the same primitive the authoritative
// `createTransactionSchema` uses (RF-126, RF-128): a light guard stricter than
// the schema it precedes would reject a row the authority accepts and never
// let the authority see it (this is the importer's own gate 1, ahead of
// `createTransactionSchema`'s gate 3 in `import-pipeline.ts`), which is a
// defect, not a stricter rule. Every caller — the webhook's structured amount
// and both importer row schemas — takes the same up-to-two-decimals reading.
export function pesoAmountSchema(keys: {
  required: string;
  invalid: string;
  tooLarge: string;
}) {
  return z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue(keys.required);
      return;
    }

    const minor = parseAmount(value);
    if (minor === null) {
      ctx.addIssue(keys.invalid);
      return;
    }

    if (minor > maxAmountMinor(BASE_CURRENCY)) {
      ctx.addIssue(keys.tooLarge);
    }
  });
}

/**
 * The shape of a money field that does not know its currency yet: it passes if
 * any offered currency reads it, since "10,50" is a dollar amount and no peso
 * amount at all (RF-121). The one right reading is `minorAmountSchema`'s, run
 * by the object that carries the currency.
 */
export function anyCurrencyAmountSchema(keys: {
  required: string;
  invalid: string;
  tooLarge: string;
}) {
  return z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue(keys.required);
      return;
    }

    const readings = OFFERED_CURRENCIES.map((currency) => ({
      currency,
      minor: parseAmount(value),
    })).filter((reading) => reading.minor !== null);

    if (readings.length === 0) {
      ctx.addIssue(keys.invalid);
      return;
    }

    if (readings.every(({ currency, minor }) => minor! > maxAmountMinor(currency))) {
      ctx.addIssue(keys.tooLarge);
    }
  });
}

/**
 * A money field read in the currency that rides in the same object (RF-121).
 * A field on its own cannot know its minor unit, so this is a check the object
 * runs and not a schema the field carries; it hands back the integer it read,
 * or null, so a caller that must add the readings up does not parse twice.
 */
export function minorAmountSchema(keys: {
  required: string;
  invalid: string;
  tooLarge: string;
}) {
  return function checkAmount(
    value: string,
    currency: CurrencyCode,
    path: (string | number)[],
    ctx: z.RefinementCtx,
  ): number | null {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: keys.required, path });
      return null;
    }

    const minor = parseAmount(value);
    if (minor === null) {
      ctx.addIssue({ code: "custom", message: keys.invalid, path });
      return null;
    }

    if (minor > maxAmountMinor(currency)) {
      ctx.addIssue({ code: "custom", message: keys.tooLarge, path });
      return null;
    }

    return minor;
  };
}

const checkTransactionAmount = minorAmountSchema({
  required: "transactions.errors.amountRequired",
  invalid: "transactions.errors.amountInvalid",
  tooLarge: "transactions.errors.amountTooLarge",
});

const checkSplitAmount = minorAmountSchema({
  required: "transactions.errors.splitAmountRequired",
  invalid: "transactions.errors.splitAmountInvalid",
  tooLarge: "transactions.errors.splitAmountTooLarge",
});

const checkCounterAmount = minorAmountSchema({
  required: "transactions.errors.counterAmountRequired",
  invalid: "transactions.errors.counterAmountInvalid",
  tooLarge: "transactions.errors.amountTooLarge",
});

const transactionAmountSchema = anyCurrencyAmountSchema({
  required: "transactions.errors.amountRequired",
  invalid: "transactions.errors.amountInvalid",
  tooLarge: "transactions.errors.amountTooLarge",
});

const splitAmountSchema = anyCurrencyAmountSchema({
  required: "transactions.errors.splitAmountRequired",
  invalid: "transactions.errors.splitAmountInvalid",
  tooLarge: "transactions.errors.splitAmountTooLarge",
});

// The codes a person may pick from, with a key of its own: every message on
// screen reaches `t()`, so a schema's own English text would never render.
const movementCurrencySchema = z.enum(OFFERED_CURRENCIES, {
  error: "transactions.errors.currencyMismatch",
});

// The source and destination stay nullable: income names only a destination,
// expense only a source, a transfer both (RF-20). The kind is derived from
// which is null, never sent.
export const accountRefSchema = z
  .uuid({ error: "transactions.errors.accountInvalid" })
  .nullable();

// The date the movement occurred; it can be past or today, never future,
// compared as a YYYY-MM-DD string end to end (RNF-06). Exported so a planned
// payment's settlement date shares the same not-future rule.
export const occurredAtSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue("transactions.errors.dateRequired");
    return;
  }

  if (!isCivilDate(value)) {
    ctx.addIssue("transactions.errors.dateInvalid");
    return;
  }

  if (value > todayInBogota()) {
    ctx.addIssue("transactions.errors.dateInFuture");
  }
});

const splitSchema = z.object({
  categoryId: z.uuid({ error: "transactions.errors.splitCategoryInvalid" }),
  amount: splitAmountSchema,
});

export const transactionFields = {
  fromAccountId: accountRefSchema,
  toAccountId: accountRefSchema,
  amount: transactionAmountSchema,
  // The currency the movement happened in, in whose minor unit its amount and
  // every split is expressed (RF-121). A split never changes currency. Absent
  // is how a writer says "derive it": the accounts decide, as they do in
  // `set_transaction_currency`, and the strings are read as base-currency ones.
  currency: movementCurrencySchema.optional(),
  // The same movement in the settlement currency of the side that settles
  // elsewhere (RF-122): required exactly then, absent otherwise, and read in
  // that account's minor unit by `refineSettlement`. Absent and null both mean
  // no second amount, as the column's null does.
  counterAmount: z.string().nullish(),
  // True while that second amount is what the person expects to be billed and
  // not what the issuer billed (RF-123). Absent is the column's own default.
  counterIsEstimate: z.boolean().optional(),
  occurredAt: occurredAtSchema,
  description: z
    .string()
    .trim()
    .max(200, { error: "transactions.errors.descriptionTooLong" })
    .nullable(),
  externalRef: z
    .string()
    .trim()
    .max(200, { error: "transactions.errors.externalRefTooLong" })
    .nullish(),
  splits: z.array(splitSchema),
  labelIds: z.array(z.uuid({ error: "transactions.errors.labelInvalid" })),
  // The movement that produced this one — a transfer's own tax or fee (RF-132).
  // The shape only: naming one the caller cannot even see is refused server
  // side, since the foreign key it lands on bypasses row security on its own
  // (migration 0040) and a shape check alone would let that slip through.
  causedByTransactionId: z
    .uuid({ error: "transactions.errors.causeInvalid" })
    .nullish(),
};

type TransactionFields = {
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  currency?: CurrencyCode;
  splits: { categoryId: string; amount: string }[];
};

// What the two named accounts settle in, read off the accounts and never off
// the payload: a movement's second amount is expressed in one of these.
export type SettlementCurrencies = {
  from: CurrencyCode | null;
  to: CurrencyCode | null;
};

type CurrencyFields = {
  fromAccountId: string | null;
  toAccountId: string | null;
  currency?: CurrencyCode;
  counterAmount?: string | null;
  counterIsEstimate?: boolean;
};

// An empty field is no amount at all: the form clears the counter to null when
// it hides it, and a blank left behind reads the same as absent.
function typedAmount(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && value.trim().length > 0
    ? value
    : null;
}

/**
 * The side that settles somewhere else, and the currency it settles in — the
 * one the second amount is expressed in (RF-122). A transfer between two
 * currencies is booked in one of them, so at most one side is ever foreign.
 */
export function foreignSettlementCurrency(
  currency: CurrencyCode,
  settlement: SettlementCurrencies,
): CurrencyCode | null {
  if (settlement.from !== null && settlement.from !== currency) return settlement.from;
  if (settlement.to !== null && settlement.to !== currency) return settlement.to;
  return null;
}

// At least one account, so income and expense stay one-sided and a transfer
// keeps both (RF-20), and the two sides of a transfer are different accounts
// (RF-101). Typed on the account pair alone so a planned payment, which carries
// no splits, reuses the very same refinement.
export function requireAnAccount(
  data: { fromAccountId: string | null; toAccountId: string | null },
  ctx: z.RefinementCtx,
) {
  if (data.fromAccountId === null && data.toAccountId === null) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.accountRequired",
      path: ["fromAccountId"],
    });
    return;
  }

  if (data.fromAccountId !== null && data.fromAccountId === data.toAccountId) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.accountSame",
      path: ["toAccountId"],
    });
  }
}

// A transfer is confirmed whole the moment it is recorded, so only a one-sided
// movement waits for a statement (RF-122, RF-123) — the same refusal the
// `transactions_verify_currency` trigger raises, in the same words. Nothing is
// an estimate of an amount nobody named.
export function refineEstimate(data: CurrencyFields, ctx: z.RefinementCtx) {
  if (!data.counterIsEstimate) return;

  if (typedAmount(data.counterAmount) === null) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.counterAmountRequired",
      path: ["counterAmount"],
    });
  }

  if (data.fromAccountId !== null && data.toAccountId !== null) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.currencyMismatch",
      path: ["counterIsEstimate"],
    });
  }
}

/**
 * The second amount is required exactly when a named account settles somewhere
 * else, forbidden when none does, and read in that account's minor unit
 * (RF-122). The currencies come from the accounts, so the form runs this
 * against the ones it was handed and the action against the ones it reads back
 * — the same rule, never the payload's word for it (RNF-10).
 */
export function refineSettlement(settlement: SettlementCurrencies) {
  return function refine(data: CurrencyFields, ctx: z.RefinementCtx) {
    const currency = data.currency ?? BASE_CURRENCY;

    // A transfer between two currencies is booked in one of them; a third is a
    // rate the movement would carry twice.
    if (
      settlement.from !== null &&
      settlement.to !== null &&
      settlement.from !== settlement.to &&
      currency !== settlement.from &&
      currency !== settlement.to
    ) {
      ctx.addIssue({
        code: "custom",
        message: "transactions.errors.currencyMismatch",
        path: ["currency"],
      });
      return;
    }

    const foreign = foreignSettlementCurrency(currency, settlement);
    const counter = typedAmount(data.counterAmount);

    if (foreign === null) {
      if (counter !== null) {
        ctx.addIssue({
          code: "custom",
          message: "transactions.errors.counterAmountForbidden",
          path: ["counterAmount"],
        });
      }
      return;
    }

    if (counter === null) {
      ctx.addIssue({
        code: "custom",
        message: "transactions.errors.counterAmountRequired",
        path: ["counterAmount"],
      });
      return;
    }

    checkCounterAmount(counter, foreign, ["counterAmount"], ctx);
  };
}

// The kind the split rule keys off is the same one the DB generates: income
// when `from` is null, expense when `to` is null, else transfer (RF-69). An
// income or expense splits into rows summing to its amount; a transfer carries
// none. Every figure here is read in the movement's own currency — the amount
// first, since a transfer has no split to read it through (RF-121).
export function refineSplits(data: TransactionFields, ctx: z.RefinementCtx) {
  const currency = data.currency ?? BASE_CURRENCY;

  const amountMinor = checkTransactionAmount(
    data.amount,
    currency,
    ["amount"],
    ctx,
  );

  const isTransfer = data.fromAccountId !== null && data.toAccountId !== null;

  if (isTransfer) {
    if (data.splits.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "transactions.errors.splitsForbidden",
        path: ["splits"],
      });
    }
    return;
  }

  if (data.splits.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.splitsRequired",
      path: ["splits"],
    });
    return;
  }

  let sumMinor = 0;
  let read = true;
  data.splits.forEach((split, index) => {
    const minor = checkSplitAmount(
      split.amount,
      currency,
      ["splits", index, "amount"],
      ctx,
    );
    if (minor === null) read = false;
    else sumMinor += minor;
  });

  if (!read || amountMinor === null) return;

  if (sumMinor !== amountMinor) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.splitsSumMismatch",
      path: ["splits"],
    });
  }
}

// A movement is never its own cause (RF-132), the same rule the DB's own check
// enforces (migration 0040) — caught here as a field error before that check
// ever fires. Only an edit can name itself; a create has no id yet to match.
function refineCauseNotSelf(
  data: { transactionId: string; causedByTransactionId?: string | null },
  ctx: z.RefinementCtx,
) {
  if (
    data.causedByTransactionId &&
    data.causedByTransactionId === data.transactionId
  ) {
    ctx.addIssue({
      code: "custom",
      message: "transactions.errors.causeSelf",
      path: ["causedByTransactionId"],
    });
  }
}

// The scope (personal or group) is resolved from the accounts by the DB
// trigger, so it never travels in the payload. What the accounts settle in is
// resolved there too, so the settlement rules ride `refineSettlement` on top of
// this schema, on both sides.
export const createTransactionSchema = z
  .object({
    ...transactionFields,
    // Minted by the form when it opens: a submit sent again after a lost answer carries the same
    // one, and the server answers with the movement the first copy booked.
    requestRef: z.uuid({ error: "errors.unexpected" }).optional(),
  })
  .superRefine(requireAnAccount)
  .superRefine(refineEstimate)
  .superRefine(refineSplits);

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

// `updated_at::text` as Postgres prints it, microseconds and offset included; never a JS `Date`,
// which keeps milliseconds only and would make the row look newer than itself.
export const POSTGRES_TIMESTAMPTZ_TEXT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

export const updateTransactionSchema = z
  .object({
    transactionId: z.uuid({ error: "errors.notFound" }),
    ...transactionFields,
    // The stamp the form loaded the movement with; a save after someone else's is refused stale.
    expectedUpdatedAt: z
      .string()
      .regex(POSTGRES_TIMESTAMPTZ_TEXT, { error: "errors.unexpected" })
      .optional(),
  })
  .superRefine(requireAnAccount)
  .superRefine(refineEstimate)
  .superRefine(refineSplits)
  .superRefine(refineCauseNotSelf);

export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

export const deleteTransactionSchema = z.object({
  transactionId: z.uuid({ error: "errors.notFound" }),
});

// A movement's missing side, filled by hand (RF-132 companion, RF-133): the
// account travels through the very same shape a form would submit, so the
// action's write and the DB's own writable-scope policy are the only judges
// of whether it may land.
export const completeCounterpartySchema = z.object({
  transactionId: z.uuid({ error: "errors.notFound" }),
  accountId: z.uuid({ error: "transactions.errors.accountInvalid" }),
});

// A malformed value never reaches Postgres: a bad type falls back to "all", a
// bad date or a repeated key drops to undefined, so the query filters on the
// well-formed subset only (RF-23).
const filterCivilDate = z
  .string()
  .refine(isCivilDate)
  .catch(() => undefined as unknown as string)
  .optional();

const filterReference = z
  .string()
  .min(1)
  .catch(() => undefined as unknown as string)
  .optional();

// The banner and the dashboard badge deep-link with `?unreviewed=1`; any other
// value drops the flag, so the ledger stays unfiltered.
const filterFlag = z
  .literal("1")
  .transform(() => true)
  .catch(() => false);

// The chip's value, mirrored one-to-one onto the movement's generated kind, with
// the transfer a kind of its own so no income or expense chip surfaces it (RF-19).
// `adjustment` is no kind: it selects the reconciliation-marked rows alone (RF-138).
export const MOVEMENT_TYPES = ["all", "expense", "income", "transfer", "adjustment"] as const;

export type MovementTypeValue = (typeof MOVEMENT_TYPES)[number];

// The list predicate a type stands for, shared by the page and the export so
// neither keeps a mapping of its own (RF-23, RF-118, RF-138).
export function movementTypeFilter(type: MovementTypeValue): {
  kind?: "expense" | "income" | "transfer";
  adjustments?: true;
} {
  if (type === "all") return {};
  if (type === "adjustment") return { adjustments: true };
  return { kind: type };
}

// The movement list's filter set exactly as it travels in the URL (RF-23, RF-89).
// The list page, the filter bar and the filtered export all parse this one
// schema, so no second copy can drift from it (RNF-10).
export const movementFiltersSchema = z.object({
  type: z.enum(MOVEMENT_TYPES).catch("all"),
  from: filterCivilDate,
  to: filterCivilDate,
  member: filterReference,
  account: filterReference,
  category: filterReference,
  label: filterReference,
  unreviewed: filterFlag,
  // The recurring rule a movement was generated by (RF-127).
  rule: filterReference,
});

