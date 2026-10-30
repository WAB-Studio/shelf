import { z } from "zod";

import { accountStatements } from "@/db/schema/account-statements";
import { accounts } from "@/db/schema/accounts";
import { budgets } from "@/db/schema/budgets";
import { categories } from "@/db/schema/categories";
import { debtTerms } from "@/db/schema/debt-terms";
import { goalContributions } from "@/db/schema/goal-contributions";
import { groupMembers } from "@/db/schema/group-members";
import { labels } from "@/db/schema/labels";
import { recurringRules } from "@/db/schema/recurring-rules";
import { savingsGoals } from "@/db/schema/savings-goals";
import { transactions } from "@/db/schema/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { centsToPesos, pesosToCents } from "@/lib/money";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { ACCOUNT_PLACEMENTS, accountCurrencySchema, createAccountSchema } from "@/lib/validation/account";
import { BUDGET_PERIODS } from "@/lib/validation/budget";
import { DEBT_KINDS } from "@/lib/validation/debt-terms";
import { CATEGORY_KINDS } from "@/lib/validation/category";
import { createMemberSchema } from "@/lib/validation/member";
import { anyCurrencyAmountSchema, occurredAtSchema, pesoAmountSchema } from "@/lib/validation/transaction";

// The entities export (RF-142) writes and import (RF-51/52) reads, in one
// declared shape so both sides agree on the columns, their order and the rule
// each cell obeys. No database access lives here: this is types and schemas.
export const SHEET_ENTITIES = [
  "accounts",
  "members",
  "categories",
  "labels",
  "recurringRules",
  "transactions",
  "budgets",
  "goals",
  "goalContributions",
  "debts",
  "statements",
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

// The entities a cell can point at by name. A dev→prod restore re-links across
// databases, so a reference travels as a name, not a uuid that means nothing there.
// A contribution names the movement it earmarks by that movement's own key (RF-87): a
// movement has no name.
export type RefEntity = "accounts" | "categories" | "labels" | "goals" | "transactions";

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
  // A rate the ledger keeps as a fraction and the sheet shows as a percentage.
  readonly percent?: true;
};

// A cell with no backing `$inferSelect` column: the export derives it from a
// related row and the import reconstructs it: a transaction's category, which lives
// on its split, and its labels, which live on `transaction_labels`.
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
type LabelModel = typeof labels.$inferSelect;
type RecurringRuleModel = typeof recurringRules.$inferSelect;
type TransactionModel = typeof transactions.$inferSelect;
type BudgetModel = typeof budgets.$inferSelect;
type GoalModel = typeof savingsGoals.$inferSelect;
type ContributionModel = typeof goalContributions.$inferSelect;
type DebtModel = typeof debtTerms.$inferSelect;
type StatementModel = typeof accountStatements.$inferSelect;

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

// A card's opening is what is owed, and the export writes it as the ledger keeps it: negative
// (RF-142). The form takes a magnitude and the commit signs it by kind, so the minus a backup
// carries is dropped here, before the form's own schema judges the figure; signing it again
// would double it. An asset keeps its minus, so the form's schema still refuses it (RF-51).
const OPENING_MINUS = /^\s*[-\u2212]/;

function asOwedMagnitude<Row extends { kind: string; amount: string }>(row: Row): Row {
  if (row.kind !== "liability" || !OPENING_MINUS.test(row.amount)) return row;
  return { ...row, amount: row.amount.replace(OPENING_MINUS, "") };
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
  .transform(asOwedMagnitude)
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

// A label lands where a new category does, so the sheet carries no placement (RF-70).
const placementSchema = z.enum(ACCOUNT_PLACEMENTS, { error: "accounts.errors.placementInvalid" });

export const labelRowSchema = z.object({
  externalRef: externalRefSchema,
  // Blank lands the label where a new category lands: the caller's fund, else with the caller.
  placement: placementSchema.nullish(),
  name: referenceNameSchema,
  color: z.enum(CATEGORY_COLORS),
});
export type LabelRow = z.infer<typeof labelRowSchema>;

// A movement's labels share one cell, their names joined by this mark: a name may hold a
// comma, and a semicolon is rarer in one.
export const LABEL_SEPARATOR = "; ";

// The cell split back into names; a blank one is no labels.
export function labelNames(cell: string | null | undefined): string[] {
  return (cell ?? "")
    .split(LABEL_SEPARATOR.trim())
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

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
  // The same movement in its account's own currency, when `currency` is another one (RF-122). Only
  // its shape is read here: the account it is expressed in is known after the name resolves. A blank
  // cell is no second amount, never a required one.
  counterAmount: z.preprocess(
    (cell) => (typeof cell === "string" && cell.trim().length === 0 ? null : cell),
    anyCurrencyAmountSchema({
      required: "transactions.errors.counterAmountRequired",
      invalid: "transactions.errors.counterAmountInvalid",
      tooLarge: "transactions.errors.amountTooLarge",
    }).nullish(),
  ),
  // TRUE while that amount is what the person expected, not what the issuer billed (RF-123); blank
  // is billed.
  counterIsEstimate: z
    .boolean()
    .nullish()
    .transform((cell) => cell ?? false),
  // Every label's name, joined by `LABEL_SEPARATOR`; each resolves like a category.
  labels: z
    .string()
    .trim()
    .nullish()
    .refine((cell) => labelNames(cell).every((name) => name.length <= 80)),
});
export type TransactionRow = z.infer<typeof transactionRowSchema>;

// A budget or a goal names its place, as an account does: the same category or account name
// may be held personally and in the fund, and the place says which one the row means (RF-140).
// TRUE lands the row archived (RF-120); blank, live.
const archivedSchema = z.literal(true).nullish();

// A limit, a target or a contribution is read in the currency its row derives (RF-121), which
// only the commit's account and fund know; the shape passes if any currency reads it.
function moneyCellSchema(entity: "budgets" | "goals", field: "limit" | "target" | "amount") {
  return anyCurrencyAmountSchema({
    required: `${entity}.errors.${field}Required`,
    invalid: `${entity}.errors.${field}Invalid`,
    tooLarge: `${entity}.errors.${field}TooLarge`,
  });
}

export const budgetRowSchema = z.object({
  externalRef: externalRefSchema,
  name: z.string().trim().max(80, { error: "budgets.errors.nameTooLong" }).nullish(),
  placement: placementSchema,
  category: referenceNameSchema,
  account: referenceNameSchema.nullish(),
  label: referenceNameSchema.nullish(),
  period: z.enum(BUDGET_PERIODS),
  limit: moneyCellSchema("budgets", "limit"),
  thresholdPct: z.number().int().min(1).max(100),
  archived: archivedSchema,
});
export type BudgetRow = z.infer<typeof budgetRowSchema>;

export const goalRowSchema = z.object({
  externalRef: externalRefSchema,
  name: referenceNameSchema,
  placement: placementSchema,
  targetAmount: moneyCellSchema("goals", "target"),
  targetDate: sheetCivilDateSchema.nullish(),
  account: referenceNameSchema.nullish(),
  archived: archivedSchema,
});
export type GoalRow = z.infer<typeof goalRowSchema>;

export const goalContributionRowSchema = z.object({
  externalRef: externalRefSchema,
  goal: referenceNameSchema,
  amount: moneyCellSchema("goals", "amount"),
  contributedOn: sheetCivilDateSchema,
  movement: externalRefSchema,
});
export type GoalContributionRow = z.infer<typeof goalContributionRowSchema>;

// The ledger keeps a rate as a fraction (0.2899); a person reads it as a percentage (28.99).
// Shifted as text, so no float ever touches it.
export function fractionToPercent(fraction: string): string {
  const [whole, decimals = ""] = fraction.trim().split(".");
  const digits = `${whole}${decimals.padEnd(2, "0")}`;
  const cut = whole.length + 2;
  const integer = digits.slice(0, cut).replace(/^0+(?=\d)/, "");
  const rest = digits.slice(cut).replace(/0+$/, "");
  return rest.length > 0 ? `${integer}.${rest}` : integer;
}

// An optional money cell reaches the guard as "" when blank (`toNameShaped`): no figure.
function blankAsNone<T extends z.ZodType>(schema: T) {
  return z.preprocess((cell) => (cell === "" ? null : cell), schema.nullish());
}

// A percentage cell, typed as text or as a number; the form's own rule reads it next.
const percentCellSchema = z.union([z.string(), z.number()]).transform(String);

// A day of the month a card cuts or falls due on.
const monthDaySchema = z.number().int().min(1).max(31);

export const debtRowSchema = z.object({
  account: referenceNameSchema,
  debtKind: z.enum(DEBT_KINDS),
  annualRate: percentCellSchema,
  minimumPayment: blankAsNone(z.string()),
  minimumPaymentPct: percentCellSchema.nullish(),
  creditLimit: blankAsNone(z.string()),
  cutOffDay: monthDaySchema.nullish(),
  dueDay: monthDaySchema.nullish(),
  aval: blankAsNone(z.string()),
});
export type DebtRow = z.infer<typeof debtRowSchema>;

// A statement's figures are what the ledger holds, signed by the account's kind: a card's
// balance owed is negative. A cell is a plain signed decimal, never read as a form's magnitude.
export const signedFigureSchema = z.string().trim().regex(/^-?\d+(\.\d{1,2})?$/);

export const STATEMENT_SOURCES = ["recorded", "imported"] as const;

// A statement's key: its account and its cut-off day (RF-129).
export function statementKey(accountId: string, cutOffDate: string): string {
  return `${accountId}|${cutOffDate}`;
}

export const statementRowSchema = z.object({
  account: referenceNameSchema,
  periodStart: sheetCivilDateSchema,
  cutOffDate: sheetCivilDateSchema,
  paymentDueDate: sheetCivilDateSchema.nullish(),
  openingBalance: blankAsNone(signedFigureSchema),
  closingBalance: signedFigureSchema,
  credits: blankAsNone(signedFigureSchema),
  debits: blankAsNone(signedFigureSchema),
  minimumPayment: blankAsNone(signedFigureSchema),
  interestCharged: blankAsNone(signedFigureSchema),
  feesCharged: blankAsNone(signedFigureSchema),
  source: z.enum(STATEMENT_SOURCES).nullish().transform((cell) => cell ?? "recorded"),
});
export type StatementRow = z.infer<typeof statementRowSchema>;

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

export const labelSheetDescriptor = {
  entity: "labels",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "placement", field: "ownerUserId" },
    { key: "name", field: "name" },
    { key: "color", field: "color" },
  ],
  rowSchema: labelRowSchema,
} satisfies SheetDescriptor<LabelModel, typeof labelRowSchema>;

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

// A movement with more than one split leaves its category blank: one cell cannot hold them.
//
// `currency` names what the row's `amount` is written in (RF-121, RF-124). The import
// never converts, so a row whose cell differs from the account it names carries that account's own amount in `counterAmount`
// (RF-122) and the estimate mark beside it (RF-123); without it the row is refused.
export const transactionSheetDescriptor = {
  entity: "transactions",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "fromAccount", field: "fromAccountId", ref: { entity: "accounts" } },
    { key: "toAccount", field: "toAccountId", ref: { entity: "accounts" } },
    { key: "amount", field: "amountCents", money: moneyBoundary },
    { key: "currency", field: "currency" },
    { key: "counterAmount", field: "counterAmountCents", money: moneyBoundary },
    { key: "counterIsEstimate", field: "counterIsEstimate" },
    { key: "category", synthetic: true, ref: { entity: "categories" } },
    { key: "occurredAt", field: "occurredAt" },
    { key: "description", field: "description" },
    { key: "adjustment", field: "reconciliationId", flag: true },
    { key: "labels", synthetic: true, ref: { entity: "labels" } },
  ],
  rowSchema: transactionRowSchema,
} satisfies SheetDescriptor<TransactionModel, typeof transactionRowSchema>;

export const budgetSheetDescriptor = {
  entity: "budgets",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "name", field: "name" },
    { key: "placement", field: "ownerUserId" },
    { key: "category", field: "categoryId", ref: { entity: "categories" } },
    { key: "account", field: "accountId", ref: { entity: "accounts" } },
    { key: "label", field: "labelId", ref: { entity: "labels" } },
    { key: "period", field: "period" },
    { key: "limit", field: "limitCents", money: moneyBoundary },
    { key: "thresholdPct", field: "thresholdPct" },
    { key: "archived", field: "archivedAt", flag: true },
  ],
  rowSchema: budgetRowSchema,
} satisfies SheetDescriptor<BudgetModel, typeof budgetRowSchema>;

export const goalSheetDescriptor = {
  entity: "goals",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "name", field: "name" },
    { key: "placement", field: "ownerUserId" },
    { key: "targetAmount", field: "targetAmountCents", money: moneyBoundary },
    { key: "targetDate", field: "targetDate" },
    { key: "account", field: "accountId", ref: { entity: "accounts" } },
    { key: "archived", field: "archivedAt", flag: true },
  ],
  rowSchema: goalRowSchema,
} satisfies SheetDescriptor<GoalModel, typeof goalRowSchema>;

// `contributedOn` is the Bogotá day of `created_at`, the day the list shows it by (RF-119).
export const goalContributionSheetDescriptor = {
  entity: "goalContributions",
  refField: "externalRef",
  columns: [
    { key: "externalRef", field: "externalRef" },
    { key: "goal", field: "goalId", ref: { entity: "goals" } },
    { key: "amount", field: "amountCents", money: moneyBoundary },
    { key: "contributedOn", field: "createdAt" },
    { key: "movement", field: "transactionId", ref: { entity: "transactions" } },
  ],
  rowSchema: goalContributionRowSchema,
} satisfies SheetDescriptor<ContributionModel, typeof goalContributionRowSchema>;

// One row per account that carries terms (RF-78): the account is its key, so a restore writes
// over the terms it already has.
export const debtSheetDescriptor = {
  entity: "debts",
  refField: "account",
  columns: [
    { key: "account", field: "accountId", ref: { entity: "accounts" } },
    { key: "debtKind", field: "debtKind" },
    { key: "annualRate", field: "annualRate", percent: true },
    { key: "minimumPayment", field: "minimumPaymentCents", money: moneyBoundary },
    { key: "minimumPaymentPct", field: "minimumPaymentPct", percent: true },
    { key: "creditLimit", field: "creditLimitCents", money: moneyBoundary },
    { key: "cutOffDay", field: "statementCutOffDay" },
    { key: "dueDay", field: "paymentDueDay" },
    { key: "aval", field: "avalCents", money: moneyBoundary },
  ],
  rowSchema: debtRowSchema,
} satisfies SheetDescriptor<DebtModel, typeof debtRowSchema>;

// A statement is final once closed (RF-129): the account and its cut-off name it, and a
// restore never writes over one already there.
export const statementSheetDescriptor = {
  entity: "statements",
  refField: "cutOffDate",
  columns: [
    { key: "account", field: "accountId", ref: { entity: "accounts" } },
    { key: "periodStart", field: "periodStart" },
    { key: "cutOffDate", field: "cutOffDate" },
    { key: "paymentDueDate", field: "paymentDueDate" },
    { key: "openingBalance", field: "openingBalanceCents", money: moneyBoundary },
    { key: "closingBalance", field: "closingBalanceCents", money: moneyBoundary },
    { key: "credits", field: "creditsCents", money: moneyBoundary },
    { key: "debits", field: "debitsCents", money: moneyBoundary },
    { key: "minimumPayment", field: "minimumPaymentCents", money: moneyBoundary },
    { key: "interestCharged", field: "interestChargedCents", money: moneyBoundary },
    { key: "feesCharged", field: "feesChargedCents", money: moneyBoundary },
    { key: "source", field: "source" },
  ],
  rowSchema: statementRowSchema,
} satisfies SheetDescriptor<StatementModel, typeof statementRowSchema>;

// The one map both sides iterate, in the fixed entity order.
export const sheetDescriptors = {
  accounts: accountSheetDescriptor,
  members: memberSheetDescriptor,
  categories: categorySheetDescriptor,
  labels: labelSheetDescriptor,
  recurringRules: recurringRuleSheetDescriptor,
  transactions: transactionSheetDescriptor,
  budgets: budgetSheetDescriptor,
  goals: goalSheetDescriptor,
  goalContributions: goalContributionSheetDescriptor,
  debts: debtSheetDescriptor,
  statements: statementSheetDescriptor,
} as const;
