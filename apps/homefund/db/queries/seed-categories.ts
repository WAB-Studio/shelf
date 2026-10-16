import "server-only";

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
