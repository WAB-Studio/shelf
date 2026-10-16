import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { fingerprint } from "@/lib/mcp/tokens";
import { challengeOf, verifierValid } from "@/lib/oauth/pkce";
import type { Transaction } from "@/lib/session";

export const ACCESS_TOKEN_SECONDS = 3600;

function mintSecret(prefix: "plo_" | "plr_" | "plc_"): string {
  return prefix + randomBytes(32).toString("base64url");
}

export type IssuedTokens = {
  personId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export async function registerClient(input: {
  name: string;
  redirectUris: string[];
  metadataUrl?: string | null;
}): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select goals.oauth_register_client(
      ${input.name}, ${sql.param(input.redirectUris)}::text[], ${input.metadataUrl ?? null}) as id`);

  return rows[0].id;
}

/**
 * Inserts under the caller's settled transaction. Columns are named: the
 * table grants INSERT on those six alone. The code leaves in clear once.
 */
export async function issueCode(
  tx: Transaction,
  input: { personId: string; clientId: string; challenge: string; redirectUri: string; resource: string },
): Promise<string> {
  const code = mintSecret("plc_");
  await tx.execute(sql`
    insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource)
    values (${input.personId}, ${input.clientId}, ${fingerprint(code)}, ${input.challenge},
            ${input.redirectUri}, ${input.resource})`);

  return code;
}

// A verifier the PKCE rule refuses never reaches the database.
export async function exchangeCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}): Promise<IssuedTokens | null> {
  if (!verifierValid(input.verifier)) return null;
  const accessToken = mintSecret("plo_");
  const refreshToken = mintSecret("plr_");
  const rows = await db.execute<{ person: string | null }>(sql`
    select goals.oauth_exchange_code(
      ${fingerprint(input.code)}, ${challengeOf(input.verifier)}, ${input.clientId}::uuid,
      ${input.redirectUri}, ${fingerprint(accessToken)}, ${fingerprint(refreshToken)}) as person`);
  const personId = rows[0]?.person;

  return personId ? { personId, accessToken, refreshToken, expiresIn: ACCESS_TOKEN_SECONDS } : null;
}

export async function refreshToken(input: { refreshToken: string; clientId: string }): Promise<IssuedTokens | null> {
  const accessToken = mintSecret("plo_");
  const next = mintSecret("plr_");
  const rows = await db.execute<{ person: string | null }>(sql`
    select goals.oauth_refresh_token(
      ${fingerprint(input.refreshToken)}, ${input.clientId}::uuid,
      ${fingerprint(accessToken)}, ${fingerprint(next)}) as person`);
  const personId = rows[0]?.person;

  return personId ? { personId, accessToken, refreshToken: next, expiresIn: ACCESS_TOKEN_SECONDS } : null;
}
