import "server-only";

import { sql } from "drizzle-orm";

/**
 * Whether a row's personal owner is another member (RF-58), and that member's
 * name. `column` is the qualified owner column as the statement writes it
 * (`b.owner_user_id`), never a Drizzle reference: one inside a projection
 * renders bare and binds inward. Both ride the statement that reads the row, so
 * naming an owner costs no round trip.
 */
export function ownerColumns(column: string) {
  const owner = sql.raw(column);

  return {
    foreignOwner: sql<boolean>`(
      ${owner} is not null and ${owner} is distinct from (select auth.uid())
    )`,
    ownerName: sql<string | null>`(
      select gm.name from group_members gm
      where gm.user_id = ${owner}
        and ${owner} is distinct from (select auth.uid())
        and gm.archived_at is null
      limit 1
    )`,
  };
}
