import { index, timestamp, uuid } from "drizzle-orm/pg-core";

import { goalsSchema } from "./_schema";
import { accessTokens, bytea } from "./access-tokens";
import { oauthClients } from "./oauth-clients";

// A refresh token's fingerprint (RP-60). RLS on, no policy and no grant: only
// the SECURITY DEFINER functions touch it.
export const oauthRefresh = goalsSchema
  .table(
    "oauth_refresh",
    {
      id: uuid().primaryKey().defaultRandom(),
      accessTokenId: uuid()
        .notNull()
        .references(() => accessTokens.id, { onDelete: "cascade" }),
      clientId: uuid()
        .notNull()
        .references(() => oauthClients.id, { onDelete: "cascade" }),
      refreshHash: bytea().notNull().unique("oauth_refresh_refresh_hash_unique"),
      createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp({ withTimezone: true }),
    },
    (t) => [
      index("oauth_refresh_access_token_id_idx").on(t.accessTokenId),
      index("oauth_refresh_client_id_idx").on(t.clientId),
    ],
  )
  .enableRLS();

export type OauthRefresh = typeof oauthRefresh.$inferSelect;
