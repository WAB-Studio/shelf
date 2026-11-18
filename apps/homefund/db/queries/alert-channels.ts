import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import type { AlertChannelFacts } from "@/lib/alert-channels";

// Where each bank or card account stands as a channel of alerts (RF-251): the last delivery that landed on it
// and how it arrived, in one round trip. A delivery belongs to the account the movement it became is on, or,
// while it waits, the account it proposes. A delivery the channel refused as no purchase (a promotion, a
// statement, a failed attempt) is no alert; a repeat of one still shows the channel alive.
export async function listAlertChannels(): Promise<AlertChannelFacts[]> {
  const rows = await withUserDb(async (tx) =>
    tx.execute<{
      id: string;
      name: string;
      last_at: string | null;
      last_via: "email" | "phone" | null;
      last30: number;
    }>(sql`
      with alerts as (
        select d.created_at, d.from_email,
          coalesce(t.from_account_id, t.to_account_id, d.proposed_account_id) as account_id
        from ingest_deliveries d
        left join transactions t on t.id = d.transaction_id
        where d.reject_reason is null or d.reject_reason = 'duplicate'
      ), per_account as (
        select account_id,
          max(created_at) as last_at,
          (array_agg(case when from_email then 'email' else 'phone' end order by created_at desc))[1] as last_via,
          (count(*) filter (where created_at >= now() - interval '30 days'))::int as last30
        from alerts
        where account_id is not null
        group by account_id
      )
      select a.id, a.name,
        to_char(p.last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_at,
        p.last_via, coalesce(p.last30, 0) as last30
      from accounts a
      left join per_account p on p.account_id = a.id
      where a.archived_at is null
        and a.parent_account_id is null
        and a.subtype in ('bank', 'card')
        and not exists (select 1 from third_party_credits c where c.receivable_account_id = a.id)
        and (a.owner_user_id = (select auth.uid()) or p.account_id is not null)
      order by p.last_at desc nulls last, a.name
    `),
  );

  return rows.map((row) => ({
    accountId: row.id,
    accountName: row.name,
    lastAlertAt: row.last_at,
    lastVia: row.last_via,
    alertsLast30Days: row.last30,
  }));
}
