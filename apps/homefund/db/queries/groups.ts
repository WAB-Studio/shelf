import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { cache } from "react";

import { insertRow } from "@/db/insert-row";
import { accounts, groupMembers, groups } from "@/db/schema";
import type { Group } from "@/db/schema";
import { getSessionUser, withUserDb } from "@/db/session";
import type { Transaction } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { GROUP_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
import { TIME_ZONE } from "@/lib/locales";
import type { Locale } from "@/lib/locales";

export type GroupSummary = Pick<Group, "id" | "name" | "currency" | "cashMode">;

/**
 * The caller's group id as a subselect, for a read that only needs to name the
 * group scope. It resolves inside the statement that uses it, so the read costs
 * one transaction instead of waiting behind `getUserGroup`'s. A personal-only
 * caller resolves to null, which makes the predicate it feeds false — the same
 * empty result the conditional branch used to produce.
 *
 * The policies still scope every row: this narrows, it never widens.
 */
export function callerGroupId(userId: string): SQL<string> {
  return sql`(select gm.group_id from group_members gm
    where gm.user_id = ${userId} and gm.archived_at is null limit 1)`;
}

// The caller's group cash mode (RF-56), resolved the same way, for the statement
// that has to know where cash sits before it can look for it.
export function callerCashMode(userId: string): SQL<Group["cashMode"]> {
  return sql`(select g.cash_mode from groups g
    join group_members gm on gm.group_id = g.id
    where gm.user_id = ${userId} and gm.archived_at is null limit 1)`;
}

// A user belongs to at most one group (RF-55): this returns it, or null when
// they run personal-only. `null` also covers a policy-filtered read, not just an
// absent membership. Deduplicated per request: the layout, the metadata and the
// page all ask for the same group.
export const getUserGroup = cache(async function getUserGroup(): Promise<GroupSummary | null> {
  const user = await getSessionUser();
  if (!user) return null;

  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({
        id: groups.id,
        name: groups.name,
        currency: groups.currency,
        cashMode: groups.cashMode,
      })
      .from(groups)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .where(and(eq(groupMembers.userId, user.id), isNull(groupMembers.archivedAt)))
      .limit(1);

    return row ?? null;
  });
});

// The caller's role in their group (RF-70): `leader` governs the group's shared
// records, `member` only reads them. `null` covers no session, no live
// membership and a policy-filtered row alike.
export const getUserGroupRole = cache(async function getUserGroupRole(): Promise<
  "leader" | "member" | null
> {
  const user = await getSessionUser();
  if (!user) return null;

  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({ role: groupMembers.role })
      .from(groupMembers)
      .where(and(eq(groupMembers.userId, user.id), isNull(groupMembers.archivedAt)))
      .limit(1);

    return row?.role ?? null;
  });
});

export type UpdateGroupSettingsArgs = {
  groupId: string;
  name: string;
  cashMode: Group["cashMode"];
  // What the group reports in (RF-121). Optional only for the callers that
  // predate the field; falls back to the group's own default so the SET
  // clause below always names it, same as `name` and `cashMode`.
  currency?: string;
  // Names a cash account created here; never touches an existing one.
  locale: Locale;
};

/**
 * Renames a group, sets where its cash sits and what it reports in, in one
 * transaction (RF-56, RF-57, RF-121). All three columns go in one statement:
 * `GRANT UPDATE (name, cash_mode, currency)` names exactly these, and a second
 * statement would pay the pooler twice for one form. The row filter is
 * `groups_update_leader`'s alone — it hands a plain member no row back, so
 * `false` is the refusal and the query asserts no role of its own.
 */
export async function updateGroupSettings({
  groupId,
  name,
  cashMode,
  currency = BASE_CURRENCY,
  locale,
}: UpdateGroupSettingsArgs): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(groups)
      .set({ name, cashMode, currency })
      .where(eq(groups.id, groupId))
      .returning({ id: groups.id });

    if (rows.length === 0) return false;

    // 'shared' names one pot, so it has to exist: without it `withdrawCash`
    // creates a fresh personal account on every withdrawal and never finds it
    // again. Switching to 'per_member' writes nothing — a balance derives from
    // movements (RNF-07), so a group cash holding money keeps it and its whole
    // history, and simply stops being what the cash scope points at.
    if (cashMode === "shared") {
      await ensureGroupCashAccount(tx, { groupId, locale, currency });
    }

    return true;
  });
}

// Creates the group's `efectivo` account only when it has none, seeded at zero
// like the one `createGroup` writes. The lookup is what keeps a group that
// already has its cash from getting a second one. Settles where the group
// does (RF-121): the currency just written in the same statement above.
async function ensureGroupCashAccount(
  tx: Transaction,
  { groupId, locale, currency }: { groupId: string; locale: Locale; currency: string },
): Promise<void> {
  const [existing] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.groupId, groupId),
        eq(accounts.subtype, "efectivo"),
        isNull(accounts.archivedAt),
      ),
    )
    .limit(1);

  if (existing) return;

  await insertRow(tx, accounts, {
    groupId,
    ownerUserId: null,
    isShared: true,
    name: GROUP_CASH_ACCOUNT_NAME[locale],
    kind: "asset",
    subtype: "efectivo",
    settlementCurrency: currency,
    initialBalanceCents: 0,
    initialBalanceOn: sql`(now() at time zone ${TIME_ZONE})::date`,
  });
}
