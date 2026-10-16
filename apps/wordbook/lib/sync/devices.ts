import "server-only";

import { sql } from "drizzle-orm";

import type { Transaction } from "@/lib/session";

// One row of the device list the account screen draws (RL-25): what the
// device is called, when it last synced, and how many searches it copied.
export type DeviceRow = {
  deviceId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  lookups: number;
};

/**
 * Every live device that has copied to this reader's account, each with its own
 * lookup count. ONE round trip: the count rides a `left join lateral`, not a
 * correlated subquery in the projection — a correlated one turns this into
 * N round trips and that never shows up reading the code (`AGENTS.md`).
 * `left join`, not `join`: a device with zero rows still has to be drawn.
 */
export async function listDevices(tx: Transaction, userId: string): Promise<DeviceRow[]> {
  const rows = await tx.execute<{
    device_id: string;
    label: string;
    // `#>>` unwraps the jsonb scalar as text: Postgres's own JSON serialisation
    // of a timestamptz is ISO 8601, unlike the driver's raw wire format, which
    // this connection reads back as `YYYY-MM-DD HH:MI:SS+00` — no `T`, not ISO.
    created_at: string;
    last_seen_at: string;
    lookups: number;
  }>(sql`
    select
      d.device_id,
      d.label,
      to_jsonb(d.created_at) #>> '{}'::text[] as created_at,
      to_jsonb(d.last_seen_at) #>> '{}'::text[] as last_seen_at,
      coalesce(l.lookups, 0) as lookups
    from devices d
    left join lateral (
      select count(*)::int as lookups
      from lookups
      where lookups.user_id = d.user_id and lookups.device_id = d.device_id
    ) l on true
    where d.user_id = ${userId} and d.retired_at is null
    order by d.last_seen_at desc
  `);

  return rows.map((row) => ({
    deviceId: row.device_id,
    label: row.label,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    lookups: row.lookups,
  }));
}

/**
 * Retires one device (RL-25): its copied searches leave the account and the
 * device is marked retired for good (`retired_at`, RL-24) — the sync route
 * refuses its id from then on, so the next round cannot bring it back. ONE
 * round trip, atomic by construction — the `gone` CTE modifies data, so
 * Postgres runs it whether or not the outer statement's `returning` is read
 * (`docs/TRAPS.md:463-486`).
 *
 * The upsert marks a device that never sealed too: its id is refused all the
 * same. `coalesce` keeps the first retirement's instant on a second call,
 * which answers `{ lookups: 0 }` rather than throwing. The `label` is the
 * `unknown:unknown` code of `lib/sync/device-label.ts`.
 *
 * The `where` narrows the index; the policies — `lookups_delete_self` and
 * `devices_*_self` — are what keep this off another reader's rows (RNL-10).
 */
export async function retireDevice(
  tx: Transaction,
  userId: string,
  deviceId: string,
): Promise<{ lookups: number }> {
  const [row] = await tx.execute<{ lookups: number }>(sql`
    with gone as (
      delete from reading.lookups where user_id = ${userId} and device_id = ${deviceId} returning 1
    )
    insert into reading.devices (user_id, device_id, label, retired_at)
    values (${userId}, ${deviceId}, 'unknown:unknown', now())
    on conflict (user_id, device_id) do update set retired_at = coalesce(devices.retired_at, now())
    returning (select count(*) from gone) as lookups
  `);

  return { lookups: row ? Number(row.lookups) : 0 };
}
