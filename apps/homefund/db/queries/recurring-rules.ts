import "server-only";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { accounts, categories, recurringRules, transactions } from "@/db/schema";
import type { RecurringRule } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";

type Frequency = RecurringRule["frequency"];

// A rule names exactly one account, so one of the two joins answers and the
// other is null — the same `coalesce` `set_transaction_currency` runs on the
// movement the rule generates. An account the caller cannot read answers null,
// so the base currency closes it.
const settledIn = sql<string>`coalesce(
  from_account.settlement_currency, to_account.settlement_currency, ${BASE_CURRENCY}
)`;

export type RecurringRuleRow = {
  id: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amountCents: number;
  // What the amount is written and read in (RF-121): the settlement currency of
  // the one account the rule names.
  currency: string;
  categoryId: string;
  description: string | null;
  frequency: Frequency;
  intervalN: number;
  dayOfMonth: number | null;
  nextRunOn: string;
  endsOn: string | null;
  isActive: boolean;
  // `updated_at::text` as Postgres prints it; an edit sends it back so a save after someone
  // else's is refused stale.
  updatedAt: string;
};

// Every readable rule, soonest next run first, in ONE round trip (RF-29); scope is
// the policy's job. The account joins ride along so no row costs a lookup of its
// own currency.
export async function listRecurringRules(): Promise<RecurringRuleRow[]> {
  return withUserDb(async (tx) =>
    tx
      .select({
        id: recurringRules.id,
        fromAccountId: recurringRules.fromAccountId,
        toAccountId: recurringRules.toAccountId,
        amountCents: recurringRules.amountCents,
        currency: settledIn,
        categoryId: recurringRules.categoryId,
        description: recurringRules.description,
        frequency: recurringRules.frequency,
        intervalN: recurringRules.intervalN,
        dayOfMonth: recurringRules.dayOfMonth,
        nextRunOn: recurringRules.nextRunOn,
        endsOn: recurringRules.endsOn,
        isActive: recurringRules.isActive,
        // Qualified: the joined accounts carry an `updated_at` of their own.
        updatedAt: sql<string>`recurring_rules.updated_at::text`,
      })
      .from(recurringRules)
      .leftJoin(
        sql`${accounts} from_account`,
        sql`from_account.id = ${recurringRules.fromAccountId}`,
      )
      .leftJoin(
        sql`${accounts} to_account`,
        sql`to_account.id = ${recurringRules.toAccountId}`,
      )
      .orderBy(asc(recurringRules.nextRunOn)),
  );
}

// The scope and `created_by` are set by the `set_recurring_rule_scope` trigger and
// absent from the INSERT grant, so no write here names them; drizzle types
// `createdBy` required, so the payload is cast past it. `is_active` starts true.
export type CreateRecurringRuleArgs = {
  fromAccountId: string | null;
  toAccountId: string | null;
  amountCents: number;
  categoryId: string;
  description: string | null;
  frequency: Frequency;
  intervalN: number;
  dayOfMonth: number | null;
  nextRunOn: string;
  endsOn: string | null;
};

export async function createRecurringRule({
  fromAccountId,
  toAccountId,
  amountCents,
  categoryId,
  description,
  frequency,
  intervalN,
  dayOfMonth,
  nextRunOn,
  endsOn,
}: CreateRecurringRuleArgs): Promise<{ recurringRuleId: string }> {
  return withUserDb(async (tx) => {
    const [row] = await insertRow(
      tx,
      recurringRules,
      {
        fromAccountId,
        toAccountId,
        amountCents,
        categoryId,
        description,
        frequency,
        intervalN,
        dayOfMonth,
        nextRunOn,
        endsOn,
      },
      { returning: { id: recurringRules.id } },
    );

    return { recurringRuleId: row.id };
  });
}

// Whether the category shares the scope of the rule's one account and the kind its
// side implies (a source is an expense, a destination income) — the pair the
// generator's split trigger asserts. A category the caller cannot see but that
// exists does not fit: it is another person's, and the foreign key ignores row
// security, so only this guard keeps a rule that can never book from being stored.
// A deleted one passes, so the foreign key answers it as a stale pick.
export async function categoryFitsRuleAccount({
  categoryId,
  fromAccountId,
  toAccountId,
}: {
  categoryId: string;
  fromAccountId: string | null;
  toAccountId: string | null;
}): Promise<boolean> {
  const accountId = fromAccountId ?? toAccountId;
  if (accountId === null) return false;

  return withUserDb(async (tx) => {
    const [seen] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!seen) {
      const probe = await tx.execute<{ gone: boolean }>(
        sql`select not private.category_exists(${categoryId}) as gone`,
      );
      return probe[0]?.gone === true;
    }

    const rows = await tx
      .select({ id: categories.id })
      .from(categories)
      .innerJoin(
        accounts,
        and(
          eq(accounts.id, accountId),
          sql`${categories.ownerUserId} is not distinct from ${accounts.ownerUserId}`,
          sql`${categories.groupId} is not distinct from ${accounts.groupId}`,
        ),
      )
      .where(
        and(
          eq(categories.id, categoryId),
          eq(categories.kind, fromAccountId !== null ? "expense" : "income"),
        ),
      )
      .limit(1);

    return rows.length > 0;
  });
}

// A definition edit rewrites every field but `is_active`, which only the
// pause/resume path owns; the boolean reports whether the policy admitted the row.
export type UpdateRecurringRuleArgs = {
  id: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amountCents: number;
  categoryId: string;
  description: string | null;
  frequency: Frequency;
  intervalN: number;
  dayOfMonth: number | null;
  nextRunOn: string;
  endsOn: string | null;
  // The rule's `updated_at::text` the form loaded; the night's run stamps it.
  expectedUpdatedAt?: string;
};

// `stale` is an edit whose form loaded the rule before the run or another save moved it.
export type RecurringRuleWriteOutcome = "done" | "missing" | "stale";

export async function updateRecurringRule({
  id,
  fromAccountId,
  toAccountId,
  amountCents,
  categoryId,
  description,
  frequency,
  intervalN,
  dayOfMonth,
  nextRunOn,
  endsOn,
  expectedUpdatedAt,
}: UpdateRecurringRuleArgs): Promise<RecurringRuleWriteOutcome> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(recurringRules)
      .set({
        fromAccountId,
        toAccountId,
        amountCents,
        categoryId,
        description,
        frequency,
        intervalN,
        dayOfMonth,
        nextRunOn,
        endsOn,
      })
      // Parsed from text inside the SQL: a `timestamptz` parameter travels through a JS
      // `Date` and loses its microseconds (docs/TRAPS.md). In the `where`, a stale row is
      // never touched, so the booked-period trigger cannot answer before the version.
      .where(
        and(
          eq(recurringRules.id, id),
          expectedUpdatedAt
            ? sql`${recurringRules.updatedAt} = ${expectedUpdatedAt}::text::timestamptz`
            : undefined,
        ),
      )
      .returning({ id: recurringRules.id });

    if (rows.length > 0) return "done";
    if (!expectedUpdatedAt) return "missing";

    // Only on a refusal: a rule the policy hides stays missing, a visible one is stale.
    const [seen] = await tx
      .select({ id: recurringRules.id })
      .from(recurringRules)
      .where(eq(recurringRules.id, id))
      .limit(1);
    return seen ? "stale" : "missing";
  });
}

export async function deleteRecurringRule({ id }: { id: string }): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(recurringRules)
      .where(eq(recurringRules.id, id))
      .returning({ id: recurringRules.id });

    return rows.length > 0;
  });
}

// Pausing or resuming flips the flag the generator reads; the row's history stays
// intact either way (RF-32).
export async function setRecurringRuleActive({
  id,
  isActive,
}: {
  id: string;
  isActive: boolean;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(recurringRules)
      .set({ isActive })
      .where(eq(recurringRules.id, id))
      .returning({ id: recurringRules.id });

    return rows.length > 0;
  });
}

// Setting or clearing the end date bounds when the rule stops generating (RF-32).
export async function setRecurringRuleEndDate({
  id,
  endsOn,
}: {
  id: string;
  endsOn: string | null;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(recurringRules)
      .set({ endsOn })
      .where(eq(recurringRules.id, id))
      .returning({ id: recurringRules.id });

    return rows.length > 0;
  });
}

// How many generated movements still await review — the count the badge shows (RF-31);
// scope is the policy's job.
export async function countUnreviewedGenerated(): Promise<number> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(isNotNull(transactions.recurringRuleId), isNull(transactions.reviewedAt)));

    return row.count;
  });
}

// Stamps a generated movement as reviewed (RF-31). The guard confirms it is
// generated and still unreviewed, so a manual row is never stamped and an already
// reviewed one is never restamped; the boolean reports whether a row was claimed.
export async function markTransactionReviewed({
  transactionId,
}: {
  transactionId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(transactions)
      .set({ reviewedAt: sql`now()` })
      .where(
        and(
          eq(transactions.id, transactionId),
          isNotNull(transactions.recurringRuleId),
          isNull(transactions.reviewedAt),
        ),
      )
      .returning({ id: transactions.id });

    return rows.length > 0;
  });
}

// The concept of one rule, for a filter chip to name (RF-127). RLS puts the
// scope: a rule from another one answers exactly as a uuid that names no rule
// at all, both `null` — never a thrown error.
export async function getRecurringRuleName({
  id,
}: {
  id: string;
}): Promise<string | null> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({ description: recurringRules.description })
      .from(recurringRules)
      .where(eq(recurringRules.id, id))
      .limit(1);

    return row?.description ?? null;
  });
}
