import "server-only";

import { asc, eq } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import type { CategoryScope } from "@/db/queries/categories";
import { categories } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { nextCategoryColor } from "@/lib/fund/category-color";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import type { Locale } from "@/lib/locales";

/**
 * Seeds the category tree into one scope, a user's or a group's (RF-64), and
 * returns how many rows it wrote. One colour per node, walked depth-first over
 * SEED_CATEGORIES so a category and the one drawn right after it never land on
 * the same free slot; a child never copies its parent's. Parents go first, ids
 * read back, because a child references one; row order out of one INSERT matches
 * the input.
 */
export async function seedCategoryTree(
  tx: Transaction,
  scope: CategoryScope,
  locale: Locale,
): Promise<number> {
  const owner =
    "ownerUserId" in scope
      ? { ownerUserId: scope.ownerUserId, groupId: null }
      : { ownerUserId: null, groupId: scope.groupId };
  const used: string[] = [];
  const seedColors = SEED_CATEGORIES.map((category) => {
    const parent = nextCategoryColor(used);
    used.push(parent);
    const children = (category.children ?? []).map(() => {
      const color = nextCategoryColor(used);
      used.push(color);
      return color;
    });
    return { parent, children };
  });
  const parentRows = await insertRow(
    tx,
    categories,
    SEED_CATEGORIES.map((category, index) => ({
      ...owner,
      name: category.name[locale],
      kind: category.kind,
      color: seedColors[index].parent,
      ...(category.key ? { seedKey: category.key } : {}),
    })),
    { returning: { id: categories.id } },
  );
  const childRows = SEED_CATEGORIES.flatMap((category, index) =>
    (category.children ?? []).map((child, childIndex) => ({
      ...owner,
      parentId: parentRows[index].id,
      name: child.name[locale],
      kind: category.kind,
      color: seedColors[index].children[childIndex],
    })),
  );
  if (childRows.length > 0) await insertRow(tx, categories, childRows);
  return parentRows.length + childRows.length;
}

/**
 * Gives a new fund the categories its founder already uses, tree, kinds, colours and the salary key
 * included, in place of the twenty defaults; a founder with none gets the defaults (RF-297). A category
 * names one scope, so the fund holds its own rows, but the set a person built is never doubled by a
 * default one.
 */
export async function seedFundCategories(
  tx: Transaction,
  groupId: string,
  ownerUserId: string,
  locale: Locale,
): Promise<number> {
  const own = await tx
    .select({
      id: categories.id,
      parentId: categories.parentId,
      name: categories.name,
      kind: categories.kind,
      color: categories.color,
      seedKey: categories.seedKey,
    })
    .from(categories)
    .where(eq(categories.ownerUserId, ownerUserId))
    .orderBy(asc(categories.createdAt), asc(categories.id));
  if (own.length === 0) return seedCategoryTree(tx, { groupId }, locale);

  const parents = own.filter((row) => row.parentId === null);
  const parentRows = await insertRow(
    tx,
    categories,
    parents.map((row) => ({
      groupId,
      name: row.name,
      kind: row.kind,
      color: row.color,
      ...(row.seedKey ? { seedKey: row.seedKey } : {}),
    })),
    { returning: { id: categories.id } },
  );
  const copyOf = new Map(parents.map((row, index) => [row.id, parentRows[index].id]));
  const children = own.filter((row) => row.parentId !== null && copyOf.has(row.parentId));
  if (children.length > 0) {
    await insertRow(
      tx,
      categories,
      children.map((row) => ({
        groupId,
        parentId: copyOf.get(row.parentId as string),
        name: row.name,
        kind: row.kind,
        color: row.color,
      })),
    );
  }
  return parents.length + children.length;
}
