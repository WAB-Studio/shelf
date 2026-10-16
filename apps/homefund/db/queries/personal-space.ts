import "server-only";

import { seedCategoryTree } from "@/db/queries/seed-categories";
import type { Transaction } from "@/db/session";
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
  return seedCategoryTree(tx, { ownerUserId: userId }, locale);
}
