import { sql } from "drizzle-orm";
import { check, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { finances } from "./_schema";

// A client that registered itself to connect (RF-168, RFC 7591), claude.ai among them. Public metadata
// that no person owns: RLS on, no policy and no grant, so only the server's own pool reads or writes it.
export const oauthClients = finances
  .table(
    "oauth_clients",
    {
      id: uuid().primaryKey().defaultRandom(),
      clientName: text().notNull(),
      redirectUris: text().array().notNull(),
      createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
      // Moved when a code is issued: a client a connector still caches is never swept, one idle for 30 days is.
      lastActiveAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      check("oauth_clients_name_length", sql`char_length(${table.clientName}) between 1 and 80`),
      check("oauth_clients_redirect_uris_count", sql`cardinality(${table.redirectUris}) between 1 and 5`),
    ],
  )
  .enableRLS();

export type OauthClient = typeof oauthClients.$inferSelect;
