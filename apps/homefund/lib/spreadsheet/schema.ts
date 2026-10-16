import { z } from "zod";

import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { groupMembers } from "@/db/schema/group-members";
import { recurringRules } from "@/db/schema/recurring-rules";
import { transactions } from "@/db/schema/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { centsToPesos, pesosToCents } from "@/lib/money";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { accountCurrencySchema, createAccountSchema } from "@/lib/validation/account";
import { CATEGORY_KINDS } from "@/lib/validation/category";
import { createMemberSchema } from "@/lib/validation/member";
import { occurredAtSchema, pesoAmountSchema } from "@/lib/validation/transaction";

// The five entities export (RF-50) writes and import (RF-51/52) reads, in one
// declared shape so both sides agree on the columns, their order and the rule
// each cell obeys. No database access lives here: this is types and schemas.
export const SHEET_ENTITIES = [
  "accounts",
  "members",
  "categories",
  "recurringRules",
  "transactions",
] as const;

export type SheetEntity = (typeof SHEET_ENTITIES)[number];

// The model carries integer cents (RNF-05); the sheet shows a decimal COP
// value. The float exists only at this presentation boundary — `toSheet` on the
// way out, `fromSheet` on the way back in — never in the model or its types.
type MoneyBoundary = {
  readonly toSheet: (cents: number) => number;
  readonly fromSheet: (pesos: number) => number;
};

const moneyBoundary: MoneyBoundary = {
  toSheet: centsToPesos,
  fromSheet: pesosToCents,
};

// The two entities a cell can point at by name. A dev→prod restore re-links across
// databases, so a reference travels as a name, not a uuid that means nothing there.
type RefEntity = "accounts" | "categories";

// One flat column of a sheet. `key` is the English header, the next-intl key a
// later UI module translates, and the field name on a parsed row; `field` is
// the `$inferSelect` column the export reads and the import writes back. A `ref`
// column shows the referenced row's NAME under `key` while `field` stays the id
// column the export resolves from (RF-49) and the import writes back after lookup.
type FieldColumn<Model> = {
  readonly key: string;
  readonly field: keyof Model & string;
  readonly money?: MoneyBoundary;
  readonly ref?: { readonly entity: RefEntity };
  // The cell says only whether `field` is set (TRUE or blank), never its value: a reconciliation id
  // means nothing after a restore, the fact that the row is an adjustment does.
  readonly flag?: true;
};

// A cell with no backing `$inferSelect` column: the export derives it from a
// related row and the import reconstructs it. The only one today is a
// transaction's category, which lives on its split, not the transaction row.
type SyntheticColumn = {
  readonly key: string;
  readonly synthetic: true;
  readonly ref?: { readonly entity: RefEntity };
};

type SheetColumn<Model> = FieldColumn<Model> | SyntheticColumn;

// A row's stable reference (`refField`) names the column an import matches on to
// update instead of duplicate (RF-52). `rowSchema` validates one parsed sheet
// row with the same rules the form and server use (RNF-10).
type SheetDescriptor<Model, Schema extends z.ZodType> = {
  readonly entity: SheetEntity;
  readonly refField: string;
  readonly columns: readonly SheetColumn<Model>[];
  readonly rowSchema: Schema;
};

// Model row types come straight from the migrations (RNF-11), never hand-copied.
type AccountModel = typeof accounts.$inferSelect;
type MemberModel = typeof groupMembers.$inferSelect;
type CategoryModel = typeof categories.$inferSelect;
type RecurringRuleModel = typeof recurringRules.$inferSelect;
type TransactionModel = typeof transactions.$inferSelect;

// Every entity now carries an `external_ref` column: its stable per-scope import
// key (RF-52), matched on to update instead of duplicate. Bounded like the model
// (trimmed, <= 200); the sheet leaves it blank for a brand-new row, so it stays
// optional — a trigger backfills it to `id::text` on insert. Nullish, not
// optional: a blank cell arrives as null, and `.optional()` refused every new row
// the RF-49 template offers.
const externalRefSchema = z.string().trim().max(200).nullish();

// A cross-entity reference travels as the referenced row's name (RF-49), bounded
// like the entities' own name (1..80). Names are not unique in a scope, so the
// later import PR resolves a name to an id and raises a per-row error on a
// duplicate — the sheet only guards the string shape here.
const referenceNameSchema = z.string().trim().min(1).max(80);

// Nullable on the side an entity omits: income names only a destination, expense
// only a source (RF-20), mirroring accountRefSchema's `.nullable()`.
const nullableReferenceNameSchema = referenceNameSchema.nullable();

// A light civil-date guard for the two dates the ledger's own schema does not
// export; the authoritative not-future and ordering rules live in the entity's
// createX schema, run by the later import PR after name→id resolution.
const sheetCivilDateSchema = z.string().trim().refine(isCivilDate);

// Accounts and members carry no cross-entity reference, so their row keeps the
// create schema unchanged, its external ref appended (RF-52).
const accountRowFields = createAccountSchema.extend({ externalRef: externalRefSchema });

// The words a workbook exported before RF-56 carries in an account's subtype cell.
// Import-only: the form refuses them, while a sheet written with them still re-imports
// and keeps matching on `external_ref` (RF-52).
export const LEGACY_ACCOUNT_SUBTYPES = {
  bancaria: "bank",
  efectivo: "cash",
  tarjeta: "card",
} as const;

// Exact keys only, with no trim or case fold: a cell that would need cleaning to
// match passes through raw, so the enum below refuses it rather than a cleaner
// laundering it into a word. `Object.hasOwn` keeps "constructor" and kin out.
function fromLegacySubtype(cell: unknown): unknown {
  return typeof cell === "string" && Object.hasOwn(LEGACY_ACCOUNT_SUBTYPES, cell)
    ? LEGACY_ACCOUNT_SUBTYPES[cell as keyof typeof LEGACY_ACCOUNT_SUBTYPES]
    : cell;
}

// The settlement currency is the one cell a workbook may not carry (RF-121). The
// form has a picker and so demands it; a sheet written before the column existed
// has nobody to choose, and re-importing one has to keep matching on `external_ref`
// rather than fail every row. So the fallback sits over the create schema and never
// inside it, and it is the same 'COP' the column itself defaults to; a sheet that
// does bring the cell is read by the picker's own enum.
//
// A stage of its own because zod admits no other place: `.extend` refuses to
// overwrite a key on a schema holding refinements, and `.safeExtend` refuses to
// widen an input, which is what a default does. The pipe fills the cell, then the
// create schema judges the row — refinements included — exactly as the form does.
export const accountRowSchema = z
  .object({
    ...accountRowFields.shape,
    // A blank cell is a sheet from before the column, or a template row nobody filled.
    settlementCurrency: accountCurrencySchema.nullish().transform((value) => value ?? BASE_CURRENCY),
    subtype: z.unknown().transform(fromLegacySubtype),
  })
  .pipe(accountRowFields);
export type AccountRow = z.infer<typeof accountRowSchema>;

export const memberRowSchema = createMemberSchema.extend({ externalRef: externalRefSchema });
export type MemberRow = z.infer<typeof memberRowSchema>;

// A category's parent is another category by name (RF-49); a top-level category
// has none, so `parent` is optional and nullable. The id-shaped rules —
// createCategorySchema, with its colour-at-top-level refinement — run in the later
// import PR after `parent` is resolved to an id.
export const categoryRowSchema = z.object({
  externalRef: externalRefSchema,
  name: referenceNameSchema,
  kind: z.enum(CATEGORY_KINDS),
  parent: referenceNameSchema.nullish(),
  color: z.enum(CATEGORY_COLORS).nullable(),
});
export type CategoryRow = z.infer<typeof categoryRowSchema>;

// A rule is one-sided (RF-29): one account by name, income or expense, never a
// transfer; its category is named too. Frequency, interval and day-of-month get a
// light guard here — the authoritative createRecurringRuleSchema, with its
// one-account and cadence refinements, runs in the later import PR after resolution.
export const recurringRuleRowSchema = z.object({
  externalRef: externalRefSchema,
  fromAccount: nullableReferenceNameSchema,
  toAccount: nullableReferenceNameSchema,
  amount: pesoAmountSchema({
    required: "recurringRules.errors.amountRequired",
    invalid: "recurringRules.errors.amountInvalid",
    tooLarge: "recurringRules.errors.amountTooLarge",
  }),
  category: referenceNameSchema,
  description: z
    .string()
    .trim()
    .max(200, { error: "recurringRules.errors.descriptionTooLong" })
    .nullish(),
  frequency: z.enum(["monthly", "weekly", "yearly"]),
  intervalN: z.number().int().min(1),
  dayOfMonth: z.number().int().min(1).max(31).nullish(),
  nextRunOn: sheetCivilDateSchema,
  endsOn: sheetCivilDateSchema.nullish(),
});
export type RecurringRuleRow = z.infer<typeof recurringRuleRowSchema>;

// A transaction owns `external_ref`, its stable import key, so that column stays as
// itself; from/to accounts resolve to names (RF-49), each nullable so income and
// expense stay one-sided and a transfer keeps both (RF-20). `category` is the name
// of the movement's single split (RF-69), nullable because a transfer names none.
// Multi-split transactions cannot round-trip through one cell: the export leaves
// it blank and the later import module reconstructs splits from the ledger side.
export const transactionRowSchema = z.object({
  externalRef: externalRefSchema,
  fromAccount: nullableReferenceNameSchema,
  toAccount: nullableReferenceNameSchema,
  amount: pesoAmountSchema({
    required: "transactions.errors.amountRequired",
    invalid: "transactions.errors.amountInvalid",
    tooLarge: "transactions.errors.amountTooLarge",
  }),
  category: nullableReferenceNameSchema,
  occurredAt: occurredAtSchema,
  description: z
    .string()
    .trim()
    .max(200, { error: "transactions.errors.descriptionTooLong" })
    .nullable(),
  // TRUE marks a reconciliation adjustment (RF-137, RF-138): the import books it as one, never as
  // income or expense. Blank for every other movement.
  adjustment: z.literal(true).nullish(),
  // Blank in a sheet written before the column existed: the account's own currency then.
  currency: accountCurrencySchema.nullish(),
});
export type TransactionRow = z.infer<typeof transactionRowSchema>;

// `placement` has no single column of its own: the export derives personal vs
// group from whether `ownerUserId` is set, and the import resolves the owner or
// group back from it.
export const accountSheetDescriptor = {
  entity: "accounts",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "name", field: "name" },
    { key: "kind", field: "kind" },
    { key: "subtype", field: "subtype" },
    { key: "placement", field: "ownerUserId" },
    { key: "institution", field: "institution" },
    { key: "amount", field: "initialBalanceCents", money: moneyBoundary },
    { key: "balanceOn", field: "initialBalanceOn" },
    { key: "settlementCurrency", field: "settlementCurrency" },
  ],
  rowSchema: accountRowSchema,
} satisfies SheetDescriptor<AccountModel, typeof accountRowSchema>;

export const memberSheetDescriptor = {
  entity: "members",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "name", field: "name" },
    { key: "email", field: "inviteEmail" },
  ],
  rowSchema: memberRowSchema,
} satisfies SheetDescriptor<MemberModel, typeof memberRowSchema>;

export const categorySheetDescriptor = {
  entity: "categories",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "name", field: "name" },
    { key: "kind", field: "kind" },
    { key: "parent", field: "parentId", ref: { entity: "categories" } },
    { key: "color", field: "color" },
  ],
  rowSchema: categoryRowSchema,
} satisfies SheetDescriptor<CategoryModel, typeof categoryRowSchema>;

export const recurringRuleSheetDescriptor = {
  entity: "recurringRules",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "fromAccount", field: "fromAccountId", ref: { entity: "accounts" } },
    { key: "toAccount", field: "toAccountId", ref: { entity: "accounts" } },
    { key: "amount", field: "amountCents", money: moneyBoundary },
    { key: "category", field: "categoryId", ref: { entity: "categories" } },
    { key: "description", field: "description" },
    { key: "frequency", field: "frequency" },
    { key: "intervalN", field: "intervalN" },
    { key: "dayOfMonth", field: "dayOfMonth" },
    { key: "nextRunOn", field: "nextRunOn" },
    { key: "endsOn", field: "endsOn" },
  ],
  rowSchema: recurringRuleRowSchema,
} satisfies SheetDescriptor<RecurringRuleModel, typeof recurringRuleRowSchema>;

// Splits and labels are nested, not flat cells: a later import module bridges
// them, so they carry no column here and stay out of the flat row schema.
//
// `currency` names what the row's `amount` is written in (RF-121, RF-124). The import
// books a row in its account's own currency and never converts, so a row whose cell
// differs from the account it names is refused: a foreign purchase on a peso card
// carries a second amount the sheet does not hold.
export const transactionSheetDescriptor = {
  entity: "transactions",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "fromAccount", field: "fromAccountId", ref: { entity: "accounts" } },
    { key: "toAccount", field: "toAccountId", ref: { entity: "accounts" } },
    { key: "amount", field: "amountCents", money: moneyBoundary },
    { key: "currency", field: "currency" },
    { key: "category", synthetic: true, ref: { entity: "categories" } },
    { key: "occurredAt", field: "occurredAt" },
    { key: "description", field: "description" },
    { key: "adjustment", field: "reconciliationId", flag: true },
  ],
  rowSchema: transactionRowSchema,
} satisfies SheetDescriptor<TransactionModel, typeof transactionRowSchema>;

// The one map both sides iterate, in the fixed entity order.
export const sheetDescriptors = {
  accounts: accountSheetDescriptor,
  members: memberSheetDescriptor,
  categories: categorySheetDescriptor,
  recurringRules: recurringRuleSheetDescriptor,
  transactions: transactionSheetDescriptor,
} as const;
