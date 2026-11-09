import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";

export type MemberContribution = {
  // The member the figure belongs to, login or not (RF-166); `userId` is their login, null without one.
  memberId: string;
  userId: string | null;
  // The currency the pot received, and the only one this figure counts
  // (RF-124). A member who put in both answers twice.
  currency: CurrencyCode;
  contributionCents: number;
};

/**
 * Each member's net contribution to the group's accounts for one window, per
 * currency, in ONE round trip (RF-66), plus the household bills they paid from
 * a personal account and marked «del hogar» (RF-139). A contribution is a transfer from a
 * member's personal account into a group account, credited to that member; a
 * return is the mirror, debited back. Only transfers touch the pot (RF-19), so
 * the join reads both sides of every transfer and nets `Σ contributions −
 * Σ returns` per member and currency. The group's own accounts are the pot, never
 * a contributor, so no group row appears (RF-67). A caller with no group has no
 * group account on either side of any transfer; the household branch, which
 * touches no group account, asks for the payer's membership itself. An income into a group
 * account counts for the member it names in «De quién» (RF-166); an income that names nobody
 * counts for no one.
 *
 * `booked` is the three-branch rule `account_balances` applies to a leg
 * (`0032_one_balance_per_currency.sql`), read against the POT's settlement
 * currency because what this counts is what entered the group's account: the
 * movement's own currency and amount, unless the pot settles elsewhere and a
 * confirmed second amount says what it settled for, which is then the figure and
 * the currency. An estimate is never one — only a one-sided movement carries one,
 * and a transfer is confirmed whole when it is recorded (RF-122, RF-123).
 */
export async function getMemberContributions(range: {
  start: string;
  endExclusive: string;
}): Promise<MemberContribution[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      member_id: string;
      user_id: string | null;
      currency: string;
      contribution_cents: string;
    }>(sql`
      select
        who.id as member_id,
        who.user_id,
        member.currency,
        coalesce(sum(member.delta), 0) as contribution_cents
      from (
        select
          case
            when ta.group_id is not null and fa.owner_user_id is not null then fa.owner_user_id
            when fa.group_id is not null and ta.owner_user_id is not null then ta.owner_user_id
          end as user_id,
          null::uuid as member_id,
          booked.currency,
          case
            when ta.group_id is not null and fa.owner_user_id is not null then booked.amount_cents
            when fa.group_id is not null and ta.owner_user_id is not null then -booked.amount_cents
            else 0
          end as delta
        from transactions t
        join accounts fa on fa.id = t.from_account_id
        join accounts ta on ta.id = t.to_account_id
        cross join lateral (values (
          case when ta.group_id is not null then ta.settlement_currency else fa.settlement_currency end
        )) as pot(settlement)
        cross join lateral (values (
          case
            when t.currency <> pot.settlement
              and t.counter_amount_cents is not null and not t.counter_is_estimate
            then pot.settlement
            else t.currency
          end,
          case
            when t.currency <> pot.settlement
              and t.counter_amount_cents is not null and not t.counter_is_estimate
            then t.counter_amount_cents
            else t.amount_cents
          end
        )) as booked(currency, amount_cents)
        where t.kind = 'transfer'
          and t.occurred_at >= ${range.start} and t.occurred_at < ${range.endExclusive}
        union all
        -- RF-139: a household bill paid from a member's personal account and marked «del hogar»
        -- counts as that member's contribution, booked as its account settled it, like a leg.
        -- A member archived since keeps it, as their transfers stay.
        select
          fa.owner_user_id,
          null::uuid,
          case when t.currency <> fa.settlement_currency
            and t.counter_amount_cents is not null and not t.counter_is_estimate
          then fa.settlement_currency else t.currency end,
          case when t.currency <> fa.settlement_currency
            and t.counter_amount_cents is not null and not t.counter_is_estimate
          then t.counter_amount_cents else t.amount_cents end
        from transactions t
        join accounts fa on fa.id = t.from_account_id
        where t.for_household
          and t.occurred_at >= ${range.start} and t.occurred_at < ${range.endExclusive}
          and exists (select 1 from group_members m where m.user_id = fa.owner_user_id)
        union all
        -- RF-166: an income into a fund account credited to the member who put it in, booked as the
        -- account settled it. An income naming nobody (every one before the field) stays out.
        select
          null::uuid,
          cm.id,
          case when t.currency <> ta.settlement_currency
            and t.counter_amount_cents is not null and not t.counter_is_estimate
          then ta.settlement_currency else t.currency end,
          case when t.currency <> ta.settlement_currency
            and t.counter_amount_cents is not null and not t.counter_is_estimate
          then t.counter_amount_cents else t.amount_cents end
        from transactions t
        join accounts ta on ta.id = t.to_account_id
        join group_members cm on cm.id = t.contributed_by_member_id
        where t.from_account_id is null
          and ta.group_id is not null
          and t.reconciliation_id is null
          and t.occurred_at >= ${range.start} and t.occurred_at < ${range.endExclusive}
      ) member
      -- A login resolves to its member row; an income already names the member.
      cross join lateral (
        select gm.id, gm.user_id
        from group_members gm
        where gm.id = member.member_id
          or (member.member_id is null and gm.user_id = member.user_id)
        order by gm.archived_at nulls first
        limit 1
      ) who
      group by who.id, who.user_id, member.currency
      order by member.currency
    `);

    // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
    return rows.map((row) => ({
      memberId: row.member_id,
      userId: row.user_id,
      currency: row.currency,
      contributionCents: Number(row.contribution_cents),
    }));
  });
}

export type FundCashBalance = {
  currency: CurrencyCode;
  balanceCents: number;
};

/**
 * What the fund's cash accounts hold now, one figure per currency, in ONE round
 * trip. The balance is the view's, derived from movements, never a stored
 * column; a currency is never added to another (RF-124). Archived accounts are
 * off the pot. RLS shows a caller with no fund no group account, so the answer
 * is empty.
 */
export async function getFundCashBalances(): Promise<FundCashBalance[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ currency: string; balance_cents: string }>(sql`
      select b.currency, sum(b.balance_cents)::text as balance_cents
      from account_balances b
      join accounts a on a.id = b.id
      where a.group_id is not null and a.subtype = 'cash' and a.archived_at is null
      group by b.currency
      order by b.currency
    `);

    return rows.map((row) => ({
      currency: row.currency,
      balanceCents: Number(row.balance_cents),
    }));
  });
}

export type UnassignedIncome = {
  currency: CurrencyCode;
  incomeCents: number;
};

/**
 * The incomes into a fund account for one window that name no member, per
 * currency, in ONE round trip (RF-167): what arrived through a quick entry, a bank
 * notice, a recurring rule or an import carries nobody, and Aportes lists it as
 * «Sin asignar» instead of dropping it. Booked as `getMemberContributions` books
 * an income, in the currency the fund account settles.
 */
export async function getUnassignedIncome(range: {
  start: string;
  endExclusive: string;
}): Promise<UnassignedIncome[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ currency: string; income_cents: string }>(sql`
      select
        case when t.currency <> ta.settlement_currency
          and t.counter_amount_cents is not null and not t.counter_is_estimate
        then ta.settlement_currency else t.currency end as currency,
        sum(case when t.currency <> ta.settlement_currency
          and t.counter_amount_cents is not null and not t.counter_is_estimate
        then t.counter_amount_cents else t.amount_cents end) as income_cents
      from transactions t
      join accounts ta on ta.id = t.to_account_id
      where t.from_account_id is null
        and ta.group_id is not null
        and t.reconciliation_id is null
        and t.contributed_by_member_id is null
        and t.occurred_at >= ${range.start} and t.occurred_at < ${range.endExclusive}
      group by 1
      order by 1
    `);

    return rows.map((row) => ({
      currency: row.currency,
      incomeCents: Number(row.income_cents),
    }));
  });
}
