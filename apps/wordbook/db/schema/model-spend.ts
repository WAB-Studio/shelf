import { sql } from "drizzle-orm";
import { check, date, integer } from "drizzle-orm/pg-core";

import { reading } from "./_schema";

// The one row per calendar day every paid model route (RL-41, RL-42, RL-44,
// RL-46, RL-58) claims from in a single conditional `on conflict do update`,
// before the provider is called — never after. A refused claim leaves it
// unmoved. Counted in calls, never in dollars.
export const modelSpend = reading.table(
  "model_spend",
  {
    day: date().primaryKey(),
    calls: integer().notNull().default(0),
  },
  (t) => [check("model_spend_calls_non_negative", sql`${t.calls} >= 0`)],
);

export type ModelSpendRow = typeof modelSpend.$inferSelect;
