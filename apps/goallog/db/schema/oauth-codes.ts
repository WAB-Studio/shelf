import { sql } from "drizzle-orm";
import { index, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";
import { accessTokens, bytea } from "./access-tokens";
import { oauthClients } from "./oauth-clients";

// An authorization code the consent issued (RP-60). Stored as a fingerprint,
// redeemed once by `goals.oauth_exchange_code`.
export const oauthCodes = goalsSchema.table(
  "oauth_codes",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    clientId: uuid()
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    codeHash: bytea().notNull().unique("oauth_codes_code_hash_unique"),
    codeChallenge: text().notNull(),
    redirectUri: text().notNull(),
    resource: text().notNull(),
    expiresAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now() + interval '10 minutes'`),
    usedAt: timestamp({ withTimezone: true }),
    // The connection this code produced: a replayed code revokes it. Set by
    // `goals.oauth_exchange_code`; no grant lets a person write it.
    accessTokenId: uuid().references(() => accessTokens.id, { onDelete: "set null" }),
  },
  (t) => [
    index("oauth_codes_user_id_idx").on(t.userId),
    index("oauth_codes_client_id_idx").on(t.clientId),
    index("oauth_codes_access_token_id_idx").on(t.accessTokenId),
    pgPolicy("oauth_codes_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("oauth_codes_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type OauthCode = typeof oauthCodes.$inferSelect;
