import "server-only";

import { desc, eq, inArray, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { accountReconciliations, accounts, transactions } from "@/db/schema";
import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { todayInBogota } from "@/lib/dates";
import { checkRealAmount, flipsSign } from "@/lib/validation/account-reconciliation";

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
  // The typed figure, negative when the count fell below zero; the account's own kind signs it in SQL.
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
      // Held to commit: a second count of this account waits here, so its pre-read below sees
      // the first one's gap and refuses `stale` instead of booking against a ledger it never saw.
      // Only a writer takes it, so a stranger never holds an account's lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${args.accountId}::text, 0))
          from accounts where id = ${args.accountId} and private.can_write_account(id)`,
      );

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

      // A movement saved after the pre-read still lands before the trigger computes the gap, so the
      // gap told back is the one booked, read off its marked movement.
      const [booked] = await tx
        .select({ amount: transactions.amountCents, into: transactions.toAccountId })
        .from(transactions)
        .where(eq(transactions.reconciliationId, row.id))
        .limit(1);
      const gapCents = booked ? (booked.into === null ? -booked.amount : booked.amount) : 0;

      return { ok: true as const, id: row.id, gapCents };
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

export type ReconcileManyItem = {
  accountId: string;
  // The written figure; read in the account's own currency, signed by the person and then by the account's kind.
  realAmount: string;
  // The derived figure the person was shown, in the ledger's own sign unless `expectedFrame` says «owed».
  // Null skips the staleness check, which only a dry run may ask for.
  expectedDerivedCents: number | null;
  // True refuses a count that looks like a sign slip (`flipsSign`) instead of booking it.
  guardSign: boolean;
};

export type ReconcileManyArgs = {
  reconciledOn: string;
  items: ReconcileManyItem[];
  // The lot is booked and rolled back: every refusal and the gaps are the real ones, nothing stays.
  dryRun: boolean;
  // «owed» reads a liability's expected figure positive, as the MCP speaks it (RF-245).
  expectedFrame: "ledger" | "owed";
};

// Every figure in the ledger's own sign: a debt is negative.
export type ReconciledRow = {
  accountId: string;
  name: string;
  kind: "asset" | "liability";
  currency: CurrencyCode;
  derivedCents: number;
  countedCents: number;
  gapCents: number;
  signFlip: boolean;
  // Null on a dry run and when the gap is zero: no movement was booked.
  reconciliationId: string | null;
};

export type ReconcileManyResult =
  | { ok: true; rows: ReconciledRow[] }
  | {
      ok: false;
      accountId: string;
      name: string | null;
      reason:
        | "stale"
        | "future"
        | "beforeOpening"
        | "beforeLatest"
        | "archived"
        | "denied"
        | "amount"
        | "signFlip";
      // The refusal's own key, when the figure typed is what failed.
      messageKey?: string;
      date?: string;
      // The figures a sign refusal names, as the ledger holds them.
      counted?: number;
      derived?: number;
      kind?: "asset" | "liability";
    };

type ManyRefusal = Extract<ReconcileManyResult, { ok: false }>;

class ManyRefused extends Error {
  constructor(public result: ManyRefusal) {
    super(result.reason);
  }
}

// A dry run ends by throwing what it computed, so the transaction rolls back and the caller still gets the rows.
class RolledBack extends Error {
  constructor(public rows: ReconciledRow[]) {
    super("dry run");
  }
}

/**
 * Counts many accounts on one day, all or nothing (RF-252). ONE transaction and a fixed number of
 * round trips, however many accounts: one lock statement, one read of every account, one multi-row
 * insert (the triggers book each gap) and one read of the gaps booked. Each account is refused in
 * the words `reconcileAccount` uses and the answer names the first one that fails; nothing is written
 * then. The locks are taken in id order so two overlapping counts cannot deadlock.
 */
export async function reconcileAccounts(args: ReconcileManyArgs): Promise<ReconcileManyResult> {
  const ids = args.items.map((item) => item.accountId);

  try {
    return await withUserDb(async (tx) => {
      // Only a writer takes a lock, so a stranger never holds an account's. `offset 0` keeps the order
      // the lock is taken in.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(a.id::text, 0))
          from (select id from accounts where id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
            and private.can_write_account(id) order by id offset 0) a`,
      );

      const found = await tx
        .select({
          id: accounts.id,
          name: accounts.name,
          kind: accounts.kind,
          currency: accounts.settlementCurrency,
          writable: sql<boolean>`private.can_write_account(accounts.id)`,
          archived: sql<boolean>`accounts.archived_at is not null`,
          openedOn: sql<string>`accounts.initial_balance_on`,
          latestOn: sql<
            string | null
          >`(select max(r.reconciled_on) from account_reconciliations r where r.account_id = accounts.id)`,
          derivedCents: sql<string>`private.account_settlement_balance_on(accounts.id, ${args.reconciledOn}::date)`,
        })
        .from(accounts)
        .where(inArray(accounts.id, ids));
      const byId = new Map(found.map((row) => [row.id, row]));

      const planned = args.items.map((item) => {
        const row = byId.get(item.accountId);
        const refuse = (
          reason: ManyRefusal["reason"],
          extra: Partial<ManyRefusal> = {},
        ): never => {
          throw new ManyRefused({
            ok: false,
            accountId: item.accountId,
            name: row?.name ?? null,
            reason,
            ...extra,
          });
        };

        if (!row || !row.writable) return refuse("denied");
        if (args.reconciledOn > todayInBogota()) return refuse("future");
        if (args.reconciledOn < row.openedOn) return refuse("beforeOpening", { date: row.openedOn });
        if (row.latestOn !== null && args.reconciledOn < row.latestOn) {
          return refuse("beforeLatest", { date: row.latestOn });
        }
        if (row.archived) return refuse("archived");

        const real = checkRealAmount(item.realAmount, row.currency);
        if (!real.ok) return refuse("amount", { messageKey: real.messageKey });

        const derivedCents = Number(row.derivedCents);
        const expected =
          item.expectedDerivedCents !== null && args.expectedFrame === "owed" && row.kind === "liability" && item.expectedDerivedCents !== 0
            ? -item.expectedDerivedCents
            : item.expectedDerivedCents;
        if (expected !== null && expected !== derivedCents) return refuse("stale");

        const countedCents = row.kind === "liability" && real.cents !== 0 ? -real.cents : real.cents;
        const signFlip = flipsSign(countedCents, derivedCents);
        if (signFlip && item.guardSign && !args.dryRun) {
          return refuse("signFlip", { counted: countedCents, derived: derivedCents, kind: row.kind });
        }

        return { row, derivedCents, countedCents, signFlip };
      });

      const inserted = await insertRow(
        tx,
        accountReconciliations,
        planned.map((plan) => ({
          accountId: plan.row.id,
          reconciledOn: args.reconciledOn,
          countedBalanceCents: plan.countedCents,
        })),
        { returning: { id: accountReconciliations.id, accountId: accountReconciliations.accountId } },
      );
      const reconciliationOf = new Map(inserted.map((row) => [row.accountId, row.id]));

      // A movement saved after the read still lands before the trigger computes the gap, so the gap told
      // back is the one booked, read off its marked movement.
      const booked = await tx
        .select({
          reconciliationId: transactions.reconciliationId,
          amount: transactions.amountCents,
          into: transactions.toAccountId,
        })
        .from(transactions)
        .where(inArray(transactions.reconciliationId, [...reconciliationOf.values()]));
      const gapOf = new Map(
        booked.map((row) => [row.reconciliationId, row.into === null ? -row.amount : row.amount]),
      );

      const rows: ReconciledRow[] = planned.map((plan) => {
        const id = reconciliationOf.get(plan.row.id) ?? null;
        const gapCents = (id !== null ? gapOf.get(id) : undefined) ?? 0;
        return {
          accountId: plan.row.id,
          name: plan.row.name,
          kind: plan.row.kind,
          currency: plan.row.currency,
          derivedCents: plan.derivedCents,
          countedCents: plan.countedCents,
          gapCents,
          signFlip: plan.signFlip,
          reconciliationId: args.dryRun || gapCents === 0 ? null : id,
        };
      });

      if (args.dryRun) throw new RolledBack(rows);
      return { ok: true as const, rows };
    });
  } catch (error) {
    if (error instanceof RolledBack) return { ok: true, rows: error.rows };
    if (error instanceof ManyRefused) return error.result;
    return mapManyRefusal(error, args);
  }
}

// A trigger's refusal that no read above caught (a day moved under the transaction) cannot say which
// account it was, so the first one stands for the lot.
function mapManyRefusal(error: unknown, args: ReconcileManyArgs): ManyRefusal {
  const code = pgErrorCode(error);
  const accountId = args.items[0].accountId;
  const base = { ok: false as const, accountId, name: null };

  if (code === "42501") return { ...base, reason: "denied" };
  if (code === "RC001") return { ...base, reason: "future" };
  if (code === "RC004") return { ...base, reason: "archived" };
  if (code === "RC002") return { ...base, reason: "beforeOpening" };
  if (code === "RC003") return { ...base, reason: "beforeLatest" };

  throw error;
}
