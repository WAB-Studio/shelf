import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";

export type MemberContribution = {
  userId: string;
  // The currency the pot received, and the only one this figure counts
  // (RF-124). A member who put in both answers twice.
  currency: CurrencyCode;
  contributionCents: number;
};

/**
 * Each member's net contribution to the group's accounts for one window, per
 * currency, in ONE round trip (RF-66). A contribution is a transfer from a
 * member's personal account into a group account, credited to that member; a
 * return is the mirror, debited back. Only transfers touch the pot (RF-19), so
 * the join reads both sides of every transfer and nets `Σ contributions −
 * Σ returns` per member and currency. The group's own accounts are the pot, never
 * a contributor, so no group row appears (RF-67). A caller with no group has no
 * group account on either side of any transfer, so the same statement returns
 * nothing — no membership read first.
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
      user_id: string;
      currency: string;
      contribution_cents: string;
    }>(sql`
      select
        member.user_id,
        member.currency,
        coalesce(sum(member.delta), 0) as contribution_cents
      from (
        select
          case
            when ta.group_id is not null and fa.owner_user_id is not null then fa.owner_user_id
            when fa.group_id is not null and ta.owner_user_id is not null then ta.owner_user_id
          end as user_id,
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
      ) member
      where member.user_id is not null
      group by member.user_id, member.currency
      order by member.currency
    `);

    // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
    return rows.map((row) => ({
      userId: row.user_id,
      currency: row.currency,
      contributionCents: Number(row.contribution_cents),
    }));
  });
}
