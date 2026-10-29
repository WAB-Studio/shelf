import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { seedCategoryTree } from "@/db/queries/seed-categories";
import { accounts, groupMembers, groups } from "@/db/schema";
import type { Group } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { getSessionUser, withUserDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { GROUP_CASH_ACCOUNT_NAME, PERSONAL_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
import { TIME_ZONE } from "@/lib/locales";
import type { Locale } from "@/lib/locales";

type CashMode = Group["cashMode"];

export type CreateGroupArgs = {
  name: string;
  leaderName: string;
  cashMode: CashMode;
  // What the group and its seeded cash account settle in (RF-121). Optional
  // only for the callers that predate the field; falls back to the base
  // currency, same as the column's own default.
  currency?: string;
  locale: Locale;
};

/**
 * One transaction: the group, the caller as its leader, the group's cash and its
 * seed categories. Order matters — the accounts and categories INSERT policies
 * ask whether the caller leads the group, which only holds once the leader row
 * lands. The group's own id is generated here, client-side: an unclaimed group
 * fails its SELECT policy, so `returning` would hand back nothing.
 */
export async function createGroup(
  args: CreateGroupArgs,
): Promise<{ groupId: string }> {
  const user = await getSessionUser();
  if (!user) throw new Error("createGroup called without a session");

  const groupId = randomUUID();

  await withUserDb((tx) => insertGroup(tx, { ...args, userId: user.id, groupId }));

  return { groupId };
}

// The insert body of `createGroup`: every statement lands in the one transaction
// it is handed. The session user and the group's id are resolved by the caller.
async function insertGroup(
  tx: Transaction,
  {
    name,
    leaderName,
    cashMode,
    currency = BASE_CURRENCY,
    locale,
    userId,
    groupId,
  }: CreateGroupArgs & { userId: string; groupId: string },
): Promise<void> {
  const today = sql`(now() at time zone ${TIME_ZONE})::date`;

  await insertRow(tx, groups, { id: groupId, name, cashMode, currency });

  await insertRow(tx, groupMembers, {
    groupId,
    userId,
    name: leaderName,
    role: "leader",
  });

  // 'shared' holds one group cash account any member may write; 'per_member'
  // seeds the leader their own personal cash and leaves the rest to join.
  // Either way the seeded account settles where the fund does (RF-121).
  if (cashMode === "shared") {
    await insertRow(tx, accounts, {
      groupId,
      ownerUserId: null,
      isShared: true,
      name: GROUP_CASH_ACCOUNT_NAME[locale],
      kind: "asset",
      subtype: "cash",
      settlementCurrency: currency,
      initialBalanceCents: 0,
      initialBalanceOn: today,
    });
  } else {
    await insertRow(tx, accounts, {
      groupId: null,
      ownerUserId: userId,
      isShared: false,
      name: PERSONAL_CASH_ACCOUNT_NAME[locale],
      kind: "asset",
      subtype: "cash",
      settlementCurrency: currency,
      initialBalanceCents: 0,
      initialBalanceOn: today,
    });
  }

  await seedCategoryTree(tx, { groupId }, locale);
}
