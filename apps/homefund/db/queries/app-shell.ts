import "server-only";

import { sql } from "drizzle-orm";

import type { GroupMember } from "@/db/schema";
import { getSessionUser, withUserDb } from "@/db/session";
import { inboxPendingCount } from "@/lib/ingest/inbox-pending";

export type ShellSummary = {
  // The caller's own name in their roster, or null when they run personal-only.
  memberName: string | null;
  role: GroupMember["role"] | null;
  // What Bandeja waits on (RF-90 deliveries and «Por completar» movements), the one
  // count the sidebar, the phone's bar and Inicio all show.
  inboxPending: number;
  // The caller's live fund (RF-55), read as getUserGroup reads it; null runs personal-only.
  group: { id: string; name: string } | null;
};

/**
 * What the sidebar names beside its destinations. Four unrelated values in one
 * statement on purpose: the shell renders on every route, so each of them alone
 * would charge that route another full turn to the pooler.
 *
 * Scope is never a parameter — the subselects run as `authenticated`, so the
 * policies decide what each one can see.
 */
export async function getShellSummary(): Promise<ShellSummary> {
  const user = await getSessionUser();
  if (!user) return { memberName: null, role: null, inboxPending: 0, group: null };

  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{
      member_name: string | null;
      role: GroupMember["role"] | null;
      pending_deliveries: number;
      awaiting_counterparty: number;
      group_id: string | null;
      group_name: string | null;
    }>(sql`select
      (select gm.name from group_members gm
        where gm.user_id = ${user.id} and gm.archived_at is null limit 1) as member_name,
      (select gm.role from group_members gm
        where gm.user_id = ${user.id} and gm.archived_at is null limit 1) as role,
      (select count(*)::int from ingest_deliveries
        where status = 'pending') as pending_deliveries,
      (select count(*)::int from transactions
        where awaiting_counterparty and reviewed_at is null) as awaiting_counterparty,
      (select g.id from groups g join group_members gm on gm.group_id = g.id
        where gm.user_id = ${user.id} and gm.archived_at is null limit 1) as group_id,
      (select g.name from groups g join group_members gm on gm.group_id = g.id
        where gm.user_id = ${user.id} and gm.archived_at is null limit 1) as group_name`);

    return {
      memberName: row.member_name,
      role: row.role,
      inboxPending: inboxPendingCount({
        deliveries: row.pending_deliveries,
        awaitingCounterparty: row.awaiting_counterparty,
      }),
      group: row.group_id !== null && row.group_name !== null
        ? { id: row.group_id, name: row.group_name } : null,
    };
  });
}
