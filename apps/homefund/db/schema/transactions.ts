import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accountReconciliations } from "./account-reconciliations";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { groups } from "./groups";
import { recurringRules } from "./recurring-rules";

// A movement of money (RF-17): income names only a destination, expense only a source, a transfer both.
export const transactions = finances.table(
  "transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal movement names its owner, a group movement names its group.
    // The scope is derived from the accounts by a trigger (migration assignment), never chosen by the user.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "restrict" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    fromAccountId: uuid().references(() => accounts.id, { onDelete: "restrict" }),
    toAccountId: uuid().references(() => accounts.id, { onDelete: "restrict" }),
    amountCents: bigint({ mode: "number" }).notNull(),
    // The ISO 4217 code the movement happened in, in whose minor unit `amount_cents` is expressed
    // (RF-121). Left unset it is derived from the accounts by `set_transaction_currency`, so an
    // account holds several currencies at once and every insert path that names none keeps working.
    currency: text().notNull(),
    // The same movement in the other side's settlement currency (RF-122), an integer in its own
    // minor unit. The rate is the quotient of the two: derived to be read, never stored — a stored
    // rate would be money in floating point.
    counterAmountCents: bigint({ mode: "number" }),
    // True while the counter amount is what a person expects, not what the issuer billed (RF-123).
    // The statement replaces the estimate and clears this, and the balance moves currency with it.
    counterIsEstimate: boolean().notNull().default(false),
    // Quick entry read the amount from words («25 mil») and the person did not retype it (RF-155).
    // Set on insert only; an edit never changes it.
    amountFromWords: boolean().notNull().default(false),
    // A household bill paid from a personal account, marked «del hogar»: it counts as its payer's
    // contribution to the fund (RF-139). Only an expense carries it; set and cleared by the person.
    forHousehold: boolean().notNull().default(false),
    // The type is derived, never chosen (RF-18): a stored generated column no INSERT can target.
    kind: text().generatedAlwaysAs(
      sql`case when from_account_id is null then 'income' when to_account_id is null then 'expense' else 'transfer' end`,
    ),
    // Date-only, interpreted in America/Bogota (RNF-06): a YYYY-MM-DD string end to end, never a JS Date.
    occurredAt: date({ mode: "string" }).notNull(),
    description: text(),
    // The rule that generated this movement (RF-31); cleared if the rule is deleted, keeping its history.
    recurringRuleId: uuid().references(() => recurringRules.id, { onDelete: "set null" }),
    // Set once a generated movement has been reviewed; null until then (RF-31).
    reviewedAt: timestamp({ withTimezone: true }),
    // True while a movement was recorded with only the side an ingest reader could
    // tell, and still needs its other account named (RF-133, RF-135). Never derived
    // from the shape of the row: every income and every expense is one-sided by
    // design (RF-17), so `from_account_id is null or to_account_id is null` alone
    // cannot mean "waiting": every income and expense matches that shape. This is the one
    // mark that says which ones actually are.
    awaitingCounterparty: boolean().notNull().default(false),
    externalRef: text(),
    // The movement that produced this one — a tax or a fee a transfer generated (RF-132). Self-
    // referencing, so the foreign key is declared below, one hop only: nothing here reads a chain.
    causedByTransactionId: uuid(),
    // The reconciliation this movement adjusts the ledger for (RF-137, RF-138). Written only by the
    // trigger that books it — no grant names the column — and it is what reports read to keep the
    // adjustment out of every income, expense and budget figure; `kind` still derives from the legs.
    reconciliationId: uuid().references(() => accountReconciliations.id, { onDelete: "cascade" }),
    createdBy: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The amount is always positive; direction supplies the sign (RF-20).
    check("transactions_amount_positive", sql`${table.amountCents} > 0`),
    check(
      "transactions_for_household_expense",
      sql`not ${table.forHousehold} or ${table.toAccountId} is null`,
    ),
    // At least one account, so income and expense stay one-sided and a transfer keeps both (RF-20).
    check(
      "transactions_at_least_one_account",
      sql`num_nonnulls(${table.fromAccountId}, ${table.toAccountId}) >= 1`,
    ),
    // A movement belongs to a user or a group, never both and never neither — mirrors accounts.
    check(
      "transactions_owner_xor_group",
      sql`(${table.ownerUserId} is not null)::int + (${table.groupId} is not null)::int = 1`,
    ),
    // A transfer names two different accounts (RF-101). `is distinct from` leaves a one-sided
    // movement legal: one side is null, so the pair still differs.
    check(
      "transactions_accounts_distinct",
      sql`${table.fromAccountId} is distinct from ${table.toAccountId}`,
    ),
    // The shape of ISO 4217, not a list of codes: which ones a person may pick is an interface question.
    check("transactions_currency_iso", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    // The counter amount is an amount like any other: absent, or positive with the direction carrying the sign.
    check(
      "transactions_counter_amount_positive",
      sql`${table.counterAmountCents} is null or ${table.counterAmountCents} > 0`,
    ),
    // Nothing is an estimate of an amount nobody named.
    check(
      "transactions_estimate_needs_counter",
      sql`${table.counterIsEstimate} = false or ${table.counterAmountCents} is not null`,
    ),
    check("transactions_description_length", sql`length(${table.description}) <= 200`),
    check("transactions_external_ref_length", sql`length(${table.externalRef}) <= 200`),
    foreignKey({
      columns: [table.causedByTransactionId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
    // A movement is never its own cause (RF-132).
    check(
      "transactions_caused_by_not_self",
      sql`${table.causedByTransactionId} is null or ${table.causedByTransactionId} <> ${table.id}`,
    ),
    // An adjustment touches one account, in its own settlement currency, so no second amount.
    check(
      "transactions_adjustment_one_leg",
      sql`${table.reconciliationId} is null or (num_nonnulls(${table.fromAccountId}, ${table.toAccountId}) = 1 and ${table.counterAmountCents} is null)`,
    ),
    // A reconciliation books at most one movement.
    uniqueIndex("transactions_reconciliation_id_unique")
      .on(table.reconciliationId)
      .where(sql`${table.reconciliationId} is not null`),
    index("transactions_occurred_at_idx").on(table.occurredAt),
    // `account_balances` sums each side of an account with no scope column in the
    // predicate, so the scope-leading composites below cannot serve it; without
    // these two it reads the table once per side, per account.
    index("transactions_from_account_id_idx")
      .on(table.fromAccountId)
      .where(sql`from_account_id is not null`),
    index("transactions_to_account_id_idx")
      .on(table.toAccountId)
      .where(sql`to_account_id is not null`),
    index("transactions_created_by_idx").on(table.createdBy),
    // The layout reads the caller's newest movement on every route (`getLastUsedAccountId`).
    index("transactions_created_by_recent_idx").on(
      table.createdBy,
      table.occurredAt.desc(),
      table.createdAt.desc(),
    ),
    // The order every movement list sorts by, so a `limit` stops early instead of sorting the ledger.
    index("transactions_recent_idx").on(table.occurredAt.desc(), table.createdAt.desc(), table.id),
    // `countUnreviewedGenerated` and the unreviewed filter: generated movements still awaiting a look.
    index("transactions_unreviewed_generated_idx")
      .on(table.id)
      .where(sql`${table.recurringRuleId} is not null and ${table.reviewedAt} is null`),
    index("transactions_recurring_rule_id_idx").on(table.recurringRuleId),
    index("transactions_caused_by_idx")
      .on(table.causedByTransactionId)
      .where(sql`${table.causedByTransactionId} is not null`),
    index("transactions_owner_user_id_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
    index("transactions_group_id_idx")
      .on(table.groupId)
      .where(sql`${table.groupId} is not null`),
    // The read Module 16 builds filters on this alone; the true rows are a small
    // fraction of the table (today: none — no writer sets it yet), so a partial
    // index keeps the scan bounded to them instead of to every movement.
    index("transactions_awaiting_counterparty_idx")
      .on(table.awaitingCounterparty)
      .where(sql`${table.awaitingCounterparty} = true`),
    // `external_ref` is unique within a scope, so re-importing the same row updates instead of
    // duplicating (RF-52); an accepted delivery carries its own ref under the same key (RF-90).
    uniqueIndex("transactions_owner_external_ref_unique")
      .on(table.ownerUserId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    uniqueIndex("transactions_group_external_ref_unique")
      .on(table.groupId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    // Universal read inside the group: your own personal movements, plus every movement of the group you belong to.
    pgPolicy("transactions_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${authUid} = ${table.ownerUserId} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // Write is bounded to own-or-shared accounts (RF-62). The USING/WITH CHECK body
    // `private.can_write_transaction` is defined in the migration assignment.
    pgPolicy("transactions_insert_writable", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId}))`,
    }),
    // An adjustment is refused here, never by a trigger: the harness deletes ledgers as the owner
    // role, and a trigger would strand its rows.
    pgPolicy("transactions_update_writable", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId})) and ${table.reconciliationId} is null`,
      withCheck: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId}))`,
    }),
    pgPolicy("transactions_delete_writable", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId})) and ${table.reconciliationId} is null`,
    }),
  ],
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
