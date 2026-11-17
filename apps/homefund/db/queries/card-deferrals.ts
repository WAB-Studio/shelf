import "server-only";

import { asc, desc, eq, sql } from "drizzle-orm";

import { jsonbParam } from "@/db/jsonb-param";
import { cardDeferrals } from "@/db/schema";
import type { CardDeferral } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { chargesInterest, deferralCost } from "@/lib/card-deferral";

// A deferral as the bank printed it, with what it costs derived on read (RF-253): a month's interest on
// what is pending, and what paying it off today saves. Scope is the policy's: `withUserDb` shows only the
// caller's readable rows.
export type CardDeferralRow = CardDeferral & {
  monthlyInterestCents: number;
  savingsCents: number;
  // More than one instalment at a rate above zero, with something pending: the one the card warns about.
  chargesInterest: boolean;
};

export function withCost(row: CardDeferral): CardDeferralRow {
  const figures = {
    originalAmountCents: row.originalAmountCents,
    instalments: row.instalments,
    pendingBalanceCents: row.pendingBalanceCents,
    annualRate: row.annualRate,
  };
  const { monthlyInterestCents, savingsCents } = deferralCost(figures);
  return { ...row, monthlyInterestCents, savingsCents, chargesInterest: chargesInterest(figures) };
}

/** The deferrals of one card, the largest pending balance first. */
export async function listCardDeferrals(accountId: string): Promise<CardDeferralRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select()
      .from(cardDeferrals)
      .where(eq(cardDeferrals.accountId, accountId))
      .orderBy(desc(cardDeferrals.pendingBalanceCents), asc(cardDeferrals.authorizationNumber));
    return rows.map(withCost);
  });
}

/** Every deferral on every card the caller reads, for the Deudas screen: ONE read, the largest pending first. */
export async function listAllCardDeferrals(): Promise<CardDeferralRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select()
      .from(cardDeferrals)
      .orderBy(desc(cardDeferrals.pendingBalanceCents), asc(cardDeferrals.authorizationNumber));
    return rows.map(withCost);
  });
}

// The columns a statement writes, in the shape `jsonb_to_recordset` reads.
export type CardDeferralWrite = {
  authorizationNumber: string;
  description: string;
  currency: string;
  originalAmountCents: number;
  instalments: number;
  currentInstalment: number;
  monthlyInstalmentCents: number;
  pendingBalanceCents: number;
  // The fraction the column stores, "0.281".
  annualRate: string;
  statementOn: string;
};

/**
 * Upserts a statement's deferrals by the bank's authorization number, in ONE statement. A row already holding
 * figures from a later statement is left alone: an older statement never overwrites a newer one. Answers the
 * authorization numbers that were written.
 */
export async function upsertCardDeferrals(accountId: string, rows: CardDeferralWrite[]): Promise<string[]> {
  if (rows.length === 0) return [];
  return withUserDb(async (tx) => {
    const written = await tx.execute<{ authorization_number: string }>(sql`
      insert into card_deferrals (account_id, authorization_number, description, currency, original_amount_cents,
        instalments, current_instalment, monthly_instalment_cents, pending_balance_cents, annual_rate, statement_on)
      select ${accountId}::uuid, r.authorization_number, r.description, r.currency, r.original_amount_cents,
        r.instalments, r.current_instalment, r.monthly_instalment_cents, r.pending_balance_cents, r.annual_rate, r.statement_on
      from jsonb_to_recordset(${jsonbParam(
        rows.map((row) => ({
          authorization_number: row.authorizationNumber,
          description: row.description,
          currency: row.currency,
          original_amount_cents: row.originalAmountCents,
          instalments: row.instalments,
          current_instalment: row.currentInstalment,
          monthly_instalment_cents: row.monthlyInstalmentCents,
          pending_balance_cents: row.pendingBalanceCents,
          annual_rate: row.annualRate,
          statement_on: row.statementOn,
        })),
      )}) as r(authorization_number text, description text, currency text, original_amount_cents bigint,
        instalments smallint, current_instalment smallint, monthly_instalment_cents bigint,
        pending_balance_cents bigint, annual_rate numeric, statement_on date)
      on conflict (account_id, authorization_number) do update set
        description = excluded.description, currency = excluded.currency,
        original_amount_cents = excluded.original_amount_cents, instalments = excluded.instalments,
        current_instalment = excluded.current_instalment, monthly_instalment_cents = excluded.monthly_instalment_cents,
        pending_balance_cents = excluded.pending_balance_cents, annual_rate = excluded.annual_rate,
        statement_on = excluded.statement_on
      where card_deferrals.statement_on <= excluded.statement_on
      returning authorization_number`);
    return written.map((row) => row.authorization_number);
  });
}
