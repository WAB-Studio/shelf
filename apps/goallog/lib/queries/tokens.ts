import "server-only";

import { sql } from "drizzle-orm";

import { returnHost } from "@/lib/oauth/return-host";
import { withGoalsDb } from "@/lib/session";

export type AccessToken = {
  id: string;
  kind: "personal" | "oauth";
  name: string;
  hint: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  // Where an OAuth connection returns; null for a personal key or an unknown address.
  returnHost: string | null;
  // Dead for more than 30 days, counted from when it stopped working, never from creation.
  folded: boolean;
};

type TokenRow = {
  id: string;
  kind: "personal" | "oauth";
  name: string;
  hint: string | null;
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
  expired_at: string | Date | null;
  redirect_uri: string | null;
  folded: boolean;
};

const iso = (value: string | Date) => new Date(value).toISOString();

// Names the granted columns: `token_hash` is in no grant, so selecting it
// would fail with 42501. RLS alone scopes the rows to the person.
// `lapses_at` is the door's rule read forward (RNP-20): `goals.access_token_lapses_at`
// holds it once, shared with `person_for_token` and `oauth_refresh_token`.
export async function listAccessTokens(): Promise<AccessToken[]> {
  const rows = await withGoalsDb((tx) =>
    tx.execute<TokenRow>(sql`
      select id, kind, name, hint, created_at, last_used_at, revoked_at, redirect_uri,
             case when lapses_at <= now() then lapses_at end as expired_at,
             coalesce(revoked_at, lapses_at) <= now() - interval '30 days' as folded
        from (
          select id, kind, name, hint, created_at, last_used_at, revoked_at, redirect_uri,
                 goals.access_token_lapses_at(kind, last_used_at, created_at, expires_at, revoked_at) as lapses_at
            from "goals"."access_tokens"
        ) t
        order by (revoked_at is not null), (lapses_at <= now()) nulls first, created_at desc
    `),
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    hint: row.hint,
    createdAt: iso(row.created_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    expiredAt: row.expired_at ? iso(row.expired_at) : null,
    returnHost: row.redirect_uri ? returnHost(row.redirect_uri) : null,
    folded: row.folded === true,
  }));
}
