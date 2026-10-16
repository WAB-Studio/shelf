import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { accounts, categories, groupMembers, groups } from "@/db/schema";
import type { Group } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { getSessionUser, withUserDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { nextCategoryColor } from "@/lib/fund/category-color";
import {
  GROUP_CASH_ACCOUNT_NAME,
  PERSONAL_CASH_ACCOUNT_NAME,
  SEED_CATEGORIES,
} from "@/lib/fund/seed";
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
      subtype: "efectivo",
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
      subtype: "efectivo",
      settlementCurrency: currency,
      initialBalanceCents: 0,
      initialBalanceOn: today,
    });
  }

  // One colour per node, walked depth-first over SEED_CATEGORIES so a category
  // and the one drawn right after it — its own first child, or the next parent
  // once it runs out of children — never land on the same free slot (D8: a
  // child used to copy `category.color` straight from its parent).
  const usedColors: string[] = [];
  const seedColors = SEED_CATEGORIES.map((category) => {
    const parent = nextCategoryColor(usedColors);
    usedColors.push(parent);
    const children = (category.children ?? []).map(() => {
      const color = nextCategoryColor(usedColors);
      usedColors.push(color);
      return color;
    });
    return { parent, children };
  });

  // Parents first, ids read back: the leader is already a member here, so the
  // categories SELECT policy admits the row and `returning` hands back each id
  // a child references. Row order out of a single INSERT matches the input.
  const parentRows = await insertRow(
    tx,
    categories,
    SEED_CATEGORIES.map((category, index) => ({
      groupId,
      ownerUserId: null,
      name: category.name[locale],
      kind: category.kind,
      color: seedColors[index].parent,
    })),
    { returning: { id: categories.id } },
  );

  // A subcategory copies its parent's kind (RF-27); its colour is its own — D8.
  const childRows = SEED_CATEGORIES.flatMap((category, index) =>
    (category.children ?? []).map((child, childIndex) => ({
      groupId,
      ownerUserId: null,
      parentId: parentRows[index].id,
      name: child.name[locale],
      kind: category.kind,
      color: seedColors[index].children[childIndex],
    })),
  );

  if (childRows.length > 0) {
    await insertRow(tx, categories, childRows);
  }
}
