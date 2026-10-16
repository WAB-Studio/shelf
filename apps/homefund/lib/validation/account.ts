import { z } from "zod";

import { currencySchema, type CurrencyCode } from "@/lib/currency";
import { isCivilDate, todayInBogota } from "@/lib/dates";
import { maxAmountMinor, parseAmount } from "@/lib/money";

// The list the screens and both sides of validation read for an account's kind (RF-09).
export const ACCOUNT_KINDS = ["asset", "liability"] as const;

// What the account is: a bank account, physical cash, or a card (RF-56).
export const ACCOUNT_SUBTYPES = ["bancaria", "efectivo", "tarjeta"] as const;

// Which subtypes each kind admits, mirroring the accounts_subtype_kind DB CHECK:
// cash and bank hold value (asset); a card is money owed (liability). The form
// offers only these per kind, and the refinement below rejects the rest.
export const SUBTYPES_BY_KIND = {
  asset: ["bancaria", "efectivo"],
  liability: ["tarjeta"],
} as const satisfies Record<
  (typeof ACCOUNT_KINDS)[number],
  readonly (typeof ACCOUNT_SUBTYPES)[number][]
>;

// Where a new account lands: owned by the caller, or held by their group (RF-60).
// The action turns this into the owner/group XOR the schema keeps off the wire.
export const ACCOUNT_PLACEMENTS = ["personal", "group"] as const;

const accountNameSchema = z
  .string()
  .trim()
  .min(1, { error: "accounts.errors.nameRequired" })
  .max(80, { error: "accounts.errors.nameTooLong" });

const accountInstitutionSchema = z
  .string()
  .trim()
  .max(80, { error: "accounts.errors.institutionTooLong" })
  .nullable();

const accountLastFourSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || /^[0-9]{4}$/.test(value), {
    error: "accounts.errors.lastFourInvalid",
  });

// The codes the picker offers, carrying the message the field shows for one
// that is not among them. Read off `currencySchema` so the list stays in one place.
// Exported required, without a default: a form has someone to choose, so it asks.
// A surface with no chooser — the RF-51 sheet — defaults it where it reads.
export const accountCurrencySchema = z.enum(currencySchema.options, {
  error: "accounts.errors.currencyInvalid",
});

// Whether the field was filled is the one amount check no currency changes; how
// many decimals it may carry and how large it may be belong to the object
// refinement below, which is where the currency is known. No sign is applied
// here either: the sign is a property of the account's kind (RF-10).
const accountAmountSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue("accounts.errors.amountRequired");
  }
});

// The date the opening balance is true as of; it can be past or today, never future.
const accountBalanceOnSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue("accounts.errors.dateRequired");
    return;
  }

  if (!isCivilDate(value)) {
    ctx.addIssue("accounts.errors.dateInvalid");
    return;
  }

  if (value > todayInBogota()) {
    ctx.addIssue("accounts.errors.dateInFuture");
  }
});

// The subtype must sit under a kind that admits it (accounts_subtype_kind); the
// error lands on the field the control shows, so the same message covers the
// form and a payload that skipped it.
function requireSubtypeUnderKind(
  data: { kind: (typeof ACCOUNT_KINDS)[number]; subtype: (typeof ACCOUNT_SUBTYPES)[number] },
  ctx: z.RefinementCtx,
) {
  if (!(SUBTYPES_BY_KIND[data.kind] as readonly string[]).includes(data.subtype)) {
    ctx.addIssue({
      code: "custom",
      message: "accounts.errors.subtypeKindMismatch",
      path: ["subtype"],
    });
  }
}

// The opening amount, read in the currency the account settles in (RF-121): a
// field alone cannot do this, since "10,50" is a dollar amount and no peso
// amount at all. Zod skips an object refinement whose shape failed, so both
// values below are already the ones their own schema admitted.
function requireAmountInCurrency(
  data: { amount: string; settlementCurrency: CurrencyCode },
  ctx: z.RefinementCtx,
) {
  // The field said so already; saying it twice puts two messages on one control.
  if (data.amount.trim().length === 0) return;

  const minor = parseAmount(data.amount);
  if (minor === null) {
    ctx.addIssue({
      code: "custom",
      message: "accounts.errors.amountInvalid",
      path: ["amount"],
    });
    return;
  }

  if (minor > maxAmountMinor(data.settlementCurrency)) {
    ctx.addIssue({
      code: "custom",
      message: "accounts.errors.amountTooLarge",
      path: ["amount"],
    });
  }
}

export const createAccountSchema = z
  .object({
    name: accountNameSchema,
    kind: z.enum(ACCOUNT_KINDS, { error: "accounts.errors.kindInvalid" }),
    subtype: z.enum(ACCOUNT_SUBTYPES, { error: "accounts.errors.subtypeInvalid" }),
    // The owner or group is resolved from the session, so only the placement travels.
    placement: z.enum(ACCOUNT_PLACEMENTS, { error: "accounts.errors.placementInvalid" }),
    institution: accountInstitutionSchema,
    lastFour: accountLastFourSchema.optional(),
    settlementCurrency: accountCurrencySchema,
    amount: accountAmountSchema,
    balanceOn: accountBalanceOnSchema,
  })
  .superRefine(requireSubtypeUnderKind)
  .superRefine(requireAmountInCurrency);

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

// `kind` and the placement are immutable after creation; only `is_shared` toggles
// whether the group may write a group account.
export const updateAccountSchema = z
  .object({
    accountId: z.uuid({ error: "errors.notFound" }),
    name: accountNameSchema,
    // `kind` never changes on the row; it rides along only so the shared
    // refinement can reject a subtype that leaves its kind server-side too.
    kind: z.enum(ACCOUNT_KINDS, { error: "accounts.errors.kindInvalid" }),
    subtype: z.enum(ACCOUNT_SUBTYPES, { error: "accounts.errors.subtypeInvalid" }),
    isShared: z.boolean(),
    institution: accountInstitutionSchema,
    lastFour: accountLastFourSchema.optional(),
    settlementCurrency: accountCurrencySchema,
    amount: accountAmountSchema,
    balanceOn: accountBalanceOnSchema,
  })
  .superRefine(requireSubtypeUnderKind)
  .superRefine(requireAmountInCurrency);

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const archiveAccountSchema = z.object({
  accountId: z.uuid({ error: "errors.notFound" }),
});

export type ArchiveAccountInput = z.infer<typeof archiveAccountSchema>;

// RF-61: the group is the caller's own, resolved from the session, so only the
// account travels.
export const handAccountToGroupSchema = z.object({
  accountId: z.uuid({ error: "errors.notFound" }),
});

export type HandAccountToGroupInput = z.infer<typeof handAccountToGroupSchema>;


export const restoreAccountSchema = z.object({
  accountId: z.uuid({ error: "errors.notFound" }),
});

export type RestoreAccountInput = z.infer<typeof restoreAccountSchema>;

export const deleteAccountSchema = z.object({
  accountId: z.uuid({ error: "errors.notFound" }),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
