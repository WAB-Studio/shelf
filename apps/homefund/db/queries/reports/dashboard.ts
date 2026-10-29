import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { getAccountBalances } from "@/db/queries/account-balances";
import { listAccounts } from "@/db/queries/accounts";
import { countPendingDeliveries } from "@/db/queries/ingest-review";
import { getMonthlyFlow } from "@/db/queries/reports/monthly-flow";
import type { MonthlyFlow } from "@/db/queries/reports/monthly-flow";
import { netWorthByOwner } from "@/db/queries/reports/net-worth";
import type { OwnerNetWorth } from "@/db/queries/reports/net-worth";
import { countUnreviewedGenerated } from "@/db/queries/recurring-rules";
import { groupMembers, groups } from "@/db/schema";
import { getSessionUser, withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";
import { currentMonthRange } from "@/lib/dates";

// A net-worth bucket carrying the display name the dashboard renders: a member's
// name, the group's name, or null for the caller's own personal-only bucket
// (RF-55), which the component labels itself off `isSelf`.
export type OwnerNetWorthNamed = OwnerNetWorth & {
  name: string | null;
  isSelf: boolean;
};

// The fund's whole net worth in one currency. There is no single figure to
// carry: two currencies are two totals, each saying which one it counts (RF-124).
export type CurrencyNetWorth = {
  currency: CurrencyCode;
  netWorthCents: number;
};

export type DashboardData = {
  hasAccounts: boolean;
  netWorth: OwnerNetWorthNamed[];
  totalNetWorth: CurrencyNetWorth[];
  monthFlow: MonthlyFlow[];
  // Generated movements still awaiting review — the "N sin revisar" badge (RF-31).
  unreviewedCount: number;
  pendingDeliveryCount: number;
};

// The caller's fund name and live roster in one statement: the group resolves in SQL
// off `auth.uid()`, so the read needs neither the session nor the group id first.
async function readFundRoster(): Promise<{
  groupName: string | null;
  members: { userId: string | null; name: string }[];
}> {
  const rows = await withUserDb((tx) =>
    tx
      .select({
        userId: groupMembers.userId,
        name: groupMembers.name,
        groupName: groups.name,
      })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(
        and(
          isNull(groupMembers.archivedAt),
          eq(
            groupMembers.groupId,
            sql`(select gm.group_id from group_members gm
              where gm.user_id = auth.uid() and gm.archived_at is null limit 1)`,
          ),
        ),
      )
      .orderBy(asc(groupMembers.name)),
  );

  return { groupName: rows[0]?.groupName ?? null, members: rows };
}

/**
 * The home dashboard's read-model: net worth per owner and this month's flow
 * (RF-88). Scope is never a parameter — every underlying query runs inside
 * `withUserDb`, so RLS restricts the rows to the caller and their one group.
 * Every read, the fund's live roster included, fans out in one `Promise.all`.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const [
    accounts,
    balances,
    monthFlow,
    roster,
    sessionUser,
    unreviewedCount,
    pendingDeliveryCount,
  ] = await Promise.all([
    listAccounts({ archived: false }),
    getAccountBalances(),
    getMonthlyFlow(currentMonthRange()),
    readFundRoster(),
    getSessionUser(),
    countUnreviewedGenerated(),
    countPendingDeliveries(),
  ]);

  // A personal-only caller has an empty roster and falls back to the `isSelf` label.
  const { groupName, members } = roster;
  const nameByUserId = new Map(
    members
      .filter((member) => member.userId !== null)
      .map((member) => [member.userId as string, member.name]),
  );

  // A group account is one bucket, never split across its members (RF-67); the
  // signed sum of derived balances IS net worth with no per-kind branch (RNF-05).
  // One bucket per owner AND currency, since an account holds several at once.
  const buckets = netWorthByOwner(accounts, balances);

  const netWorth: OwnerNetWorthNamed[] = buckets.map((bucket) => {
    if (bucket.bucket === "group") {
      return { ...bucket, name: groupName, isSelf: false };
    }

    const isSelf = bucket.ownerUserId !== null && bucket.ownerUserId === sessionUser?.id;
    return {
      ...bucket,
      name: bucket.ownerUserId ? nameByUserId.get(bucket.ownerUserId) ?? null : null,
      isSelf,
    };
  });

  // The buckets folded again, this time over the currency alone. In code order,
  // so two renders draw the figures in the same places.
  const totalByCurrency = new Map<CurrencyCode, number>();
  for (const bucket of buckets) {
    const running = totalByCurrency.get(bucket.currency) ?? 0;
    totalByCurrency.set(bucket.currency, running + bucket.netWorthCents);
  }

  const totalNetWorth: CurrencyNetWorth[] = [...totalByCurrency]
    .map(([currency, netWorthCents]) => ({ currency, netWorthCents }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    hasAccounts: accounts.length > 0,
    netWorth,
    totalNetWorth,
    monthFlow,
    unreviewedCount,
    pendingDeliveryCount,
  };
}
