import { sql } from "drizzle-orm";
import { index, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { oauthClients } from "./oauth-clients";
import { webhookCredentials } from "./webhook-credentials";

// An authorization code the consent issued (RF-168). Kept as a SHA-256 hash, redeemed once by
// `private.exchange_oauth_code`, which mints the `mcp` credential. RLS on; the consent's insert is the only policy and grant.
export const oauthCodes = finances
  .table(
    "oauth_codes",
    {
      id: uuid().primaryKey().defaultRandom(),
      ownerUserId: uuid()
        .notNull()
        .references(() => appUsers.id, { onDelete: "cascade" }),
      clientId: uuid()
        .notNull()
        .references(() => oauthClients.id, { onDelete: "cascade" }),
      codeHash: text().notNull().unique("oauth_codes_code_hash_unique"),
      codeChallenge: text().notNull(),
      redirectUri: text().notNull(),
      expiresAt: timestamp({ withTimezone: true })
        .notNull()
        .default(sql`now() + interval '10 minutes'`),
      usedAt: timestamp({ withTimezone: true }),
      // The key this code bought: a replayed code revokes it.
      credentialId: uuid().references(() => webhookCredentials.id, { onDelete: "set null" }),
      createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index("oauth_codes_owner_user_id_idx").on(table.ownerUserId),
      index("oauth_codes_client_id_idx").on(table.clientId),
      index("oauth_codes_credential_id_idx").on(table.credentialId),
      // The consent writes the code as the person who said yes, so the audit log names them. Nothing else is granted.
      pgPolicy("oauth_codes_insert", {
        for: "insert",
        to: authenticatedRole,
        withCheck: sql`${table.ownerUserId} = ${authUid}`,
      }),
    ],
  )
  .enableRLS();

export type OauthCode = typeof oauthCodes.$inferSelect;
