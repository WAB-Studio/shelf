import { sql } from "drizzle-orm";
import { check, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";

// A client that asked to connect (RP-60). Hangs off no person; its metadata is
// public, so the consent screen reads it. Written only by `goals.oauth_register_client`.
export const oauthClients = goalsSchema.table(
  "oauth_clients",
  {
    id: uuid().primaryKey().defaultRandom(),
    clientName: text().notNull(),
    redirectUris: text().array().notNull(),
    // Set for a client named by its metadata document; null for a registered one.
    metadataUrl: text().unique("oauth_clients_metadata_url_unique"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("oauth_clients_name_length", sql`char_length(${t.clientName}) between 1 and 80`),
    check("oauth_clients_redirect_uris_count", sql`cardinality(${t.redirectUris}) between 1 and 5`),
    pgPolicy("oauth_clients_select_all", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
  ],
);

export type OauthClient = typeof oauthClients.$inferSelect;
