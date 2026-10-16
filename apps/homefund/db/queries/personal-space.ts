import "server-only";

import { insertRow } from "@/db/insert-row";
import { categories } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { nextCategoryColor } from "@/lib/fund/category-color";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import type { Locale } from "@/lib/locales";

/**
 * Seeds a user's personal category set in the language they arrived in (RF-64),
 * the personal half of what `createGroup` writes for a group. Without it a
 * personal-only user (RF-55) has nothing to split an expense across, and RF-69
 * requires every expense to carry a split.
 *
 * Runs on the caller's transaction and opens none: the confirm route is already
 * inside `withUserDb`, under the session `categories_insert_personal` reads.
 * Returns how many rows landed.
 */
export async function seedPersonalCategories(
  tx: Transaction,
  { userId, locale }: { userId: string; locale: Locale },
): Promise<number> {
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

  // Parents first, ids read back: the insert policy admits a row the caller
  // owns, so `returning` hands back each id a child references. Row order out of
  // a single INSERT matches the input.
  const parentRows = await insertRow(
    tx,
    categories,
    SEED_CATEGORIES.map((category, index) => ({
      ownerUserId: userId,
      groupId: null,
      name: category.name[locale],
      kind: category.kind,
      color: seedColors[index].parent,
    })),
    { returning: { id: categories.id } },
  );

  // A subcategory copies its parent's kind (RF-27); its colour is its own — D8.
  const childRows = SEED_CATEGORIES.flatMap((category, index) =>
    (category.children ?? []).map((child, childIndex) => ({
      ownerUserId: userId,
      groupId: null,
      parentId: parentRows[index].id,
      name: child.name[locale],
      kind: category.kind,
      color: seedColors[index].children[childIndex],
    })),
  );

  if (childRows.length > 0) {
    await insertRow(tx, categories, childRows);
  }

  return parentRows.length + childRows.length;
}
