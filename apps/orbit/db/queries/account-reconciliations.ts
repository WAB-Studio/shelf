import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { accountReconciliations, accounts } from "@/db/schema";
import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";

export type ReconciliationRow = {
  id: string;
  reconciledOn: string;
  // What the person counted, signed like the account.
  countedCents: number;
  // What the database booked against the ledger: + into the account, − out of it, 0 when none.
  gapCents: number;
  // What HomeFund said that day, read back as counted − gap; never stored.
  derivedCents: number;
  transactionId: string | null;
};

export type ReconcileSheet = {
  account: {
    id: string;
    name: string;
    kind: "asset" | "liability";
    settlementCurrency: CurrencyCode;
    canWrite: boolean;
    archived: boolean;
    openedOn: string;
    latestReconciledOn: string | null;
    // The account's balance on the asked day, in its settlement currency (RF-137).
    derivedCents: number;
  };
  // Newest day first, then newest write first.
  history: ReconciliationRow[];
};

/**
 * One account's reconciliations, newest first, each with the gap it booked (RF-137). ONE round
 * trip: the booked movement rides a left join on its mark, and the derived figure is arithmetic
 * on the two stored ones.
 */
export async function listAccountReconciliations(
  accountId: string,
): Promise<ReconciliationRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select({
        id: accountReconciliations.id,
        reconciledOn: accountReconciliations.reconciledOn,
        countedCents: accountReconciliations.countedBalanceCents,
        // Written with the joined alias: a column reference inside a projection renders bare.
        gapCents: sql<string>`coalesce(case when t.to_account_id is not null then t.amount_cents else -t.amount_cents end, 0)`,
        transactionId: sql<string | null>`t.id`,
      })
      .from(accountReconciliations)
      .leftJoin(
        sql`transactions t`,
        sql`t.reconciliation_id = "account_reconciliations"."id"`,
      )
      .where(eq(accountReconciliations.accountId, accountId))
      .orderBy(
        desc(accountReconciliations.reconciledOn),
        desc(accountReconciliations.createdAt),
      );

    return rows.map((row) => {
      const gapCents = Number(row.gapCents);
      return {
        id: row.id,
        reconciledOn: row.reconciledOn,
        countedCents: row.countedCents,
        gapCents,
        derivedCents: row.countedCents - gapCents,
        transactionId: row.transactionId,
      };
    });
  });
}

async function readReconcileHeader(
  accountId: string,
  on: string,
): Promise<ReconcileSheet["account"] | null> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({
        id: accounts.id,
        name: accounts.name,
        kind: accounts.kind,
        settlementCurrency: accounts.settlementCurrency,
        canWrite: sql<boolean>`private.can_write_account(accounts.id)`,
        archived: sql<boolean>`accounts.archived_at is not null`,
        openedOn: sql<string>`accounts.initial_balance_on`,
        latestReconciledOn: sql<
          string | null
        >`(select max(r.reconciled_on) from account_reconciliations r where r.account_id = accounts.id)`,
        derivedCents: sql<string>`private.account_settlement_balance_on(accounts.id, ${on}::date)`,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    return row ? { ...row, derivedCents: Number(row.derivedCents) } : null;
  });
}

/**
 * Everything the «Cuadrar» sheet draws (RF-137): the account's header with the figure HomeFund
 * derives for `on`, beside its reconciliations. TWO independent reads in ONE `Promise.all`.
 * Null when the account is absent or outside the caller's read scope.
 */
export async function getReconcileSheet(
  accountId: string,
  on: string,
): Promise<ReconcileSheet | null> {
  const [account, history] = await Promise.all([
    readReconcileHeader(accountId, on),
    listAccountReconciliations(accountId),
  ]);

  return account === null ? null : { account, history };
}

export type ReconcileAccountArgs = {
  accountId: string;
  reconciledOn: string;
  // The typed figure, unsigned; the account's own kind signs it in SQL.
  realMagnitudeCents: number;
  // The derived figure the person was shown.
  expectedDerivedCents: number;
};

export type ReconcileAccountResult =
  | { ok: true; id: string; gapCents: number }
  | {
      ok: false;
      reason: "stale" | "future" | "beforeOpening" | "beforeLatest" | "archived" | "denied";
      date?: string;
    };

// The same shape as `account-statements.ts`: the sign is the account's, resolved where the row is written.
function signedByAccountKind(accountId: string, magnitudeCents: number) {
  return sql`case when (select kind from accounts where id = ${accountId}) = 'liability'
    then -${magnitudeCents}::bigint else ${magnitudeCents}::bigint end`;
}

// A stale or denied attempt is a result, not an error: nothing was written either way.
class Refused extends Error {
  constructor(public result: Extract<ReconcileAccountResult, { ok: false }>) {
    super(result.reason);
  }
}

/**
 * Counts an account on a day (RF-137). One transaction: the derived figure is read again and a
 * different one than the person saw refuses `stale` before anything is written; the insert then
 * lets the database check the day (RC001-RC004) and book the gap as the account's marked
 * adjustment. A zero gap books nothing.
 */
export async function reconcileAccount(
  args: ReconcileAccountArgs,
): Promise<ReconcileAccountResult> {
  try {
    return await withUserDb(async (tx) => {
      const [now] = await tx
        .select({
          writable: sql<boolean>`private.can_write_account(accounts.id)`,
          derivedCents: sql<string>`private.account_settlement_balance_on(accounts.id, ${args.reconciledOn}::date)`,
        })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .limit(1);

      if (!now || !now.writable) throw new Refused({ ok: false, reason: "denied" });
      const derivedCents = Number(now.derivedCents);
      if (derivedCents !== args.expectedDerivedCents) {
        throw new Refused({ ok: false, reason: "stale" });
      }

      const [row] = await insertRow(
        tx,
        accountReconciliations,
        {
          accountId: args.accountId,
          reconciledOn: args.reconciledOn,
          countedBalanceCents: signedByAccountKind(args.accountId, args.realMagnitudeCents),
        },
        {
          returning: {
            id: accountReconciliations.id,
            countedCents: accountReconciliations.countedBalanceCents,
          },
        },
      );

      return { ok: true as const, id: row.id, gapCents: row.countedCents - derivedCents };
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    return mapRefusal(error, args);
  }
}

// The transaction is gone, so the date a refusal names is read after it, in a fresh one.
async function mapRefusal(
  error: unknown,
  args: ReconcileAccountArgs,
): Promise<ReconcileAccountResult> {
  const code = pgErrorCode(error);

  if (code === "42501") return { ok: false, reason: "denied" };
  if (code === "RC001") return { ok: false, reason: "future" };
  if (code === "RC004") return { ok: false, reason: "archived" };

  if (code === "RC002" || code === "RC003") {
    const header = await readReconcileHeader(args.accountId, args.reconciledOn);
    const date = code === "RC002" ? header?.openedOn : (header?.latestReconciledOn ?? undefined);
    return {
      ok: false,
      reason: code === "RC002" ? "beforeOpening" : "beforeLatest",
      ...(date ? { date } : {}),
    };
  }

  throw error;
}
