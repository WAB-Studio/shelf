import "server-only";

import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CLAUDE_KEY_RATE_LIMIT_PER_MIN } from "@/db/queries/webhook-credentials";
import { oauthClients } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { sha256Hex } from "@/lib/hash";
import { challengeOf, verifierValid } from "@/lib/oauth/pkce";

export type RegisteredClient = { id: string; name: string; redirectUris: string[] };

// The sweep of idle clients and of spent codes rides on the statement (`private.register_oauth_client`).
export async function registerClient(input: { name: string; redirectUris: string[] }): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select private.register_oauth_client(${input.name}, ${sql.param(input.redirectUris)}::text[]) as id`);

  return rows[0].id;
}

export async function findClient(id: string): Promise<RegisteredClient | null> {
  const [row] = await db
    .select({ id: oauthClients.id, name: oauthClients.clientName, redirectUris: oauthClients.redirectUris })
    .from(oauthClients)
    .where(eq(oauthClients.id, id));

  return row ?? null;
}

// The code leaves in clear once; the row keeps its hash. It is written as the approving person, so the audit
// log names them, and it moves the client's last activity.
export async function issueCode(input: {
  ownerUserId: string;
  clientId: string;
  challenge: string;
  redirectUri: string;
}): Promise<string> {
  const code = `hfc_${randomBytes(32).toString("base64url")}`;
  await withUserDb((tx) =>
    tx.execute(sql`
      insert into finances.oauth_codes (owner_user_id, client_id, code_hash, code_challenge, redirect_uri)
      values (${input.ownerUserId}, ${input.clientId}, ${sha256Hex(code)}, ${input.challenge}, ${input.redirectUri})`),
  );
  await db.execute(sql`update finances.oauth_clients set last_active_at = now() where id = ${input.clientId}`);

  return code;
}

// A verifier the PKCE rule refuses never reaches the database. The access token is the `mcp` key the
// code buys: the same `whk_` bearer Ajustes lists, so revoking it there disconnects Claude.
export async function exchangeCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}): Promise<string | null> {
  if (!verifierValid(input.verifier)) return null;
  const accessToken = `whk_${randomBytes(32).toString("base64url")}`;
  const rows = await db.execute<{ owner: string | null }>(sql`
    select private.exchange_oauth_code(
      ${sha256Hex(input.code)}, ${challengeOf(input.verifier)}, ${input.clientId}::uuid,
      ${input.redirectUri}, ${sha256Hex(accessToken)}, ${CLAUDE_KEY_RATE_LIMIT_PER_MIN}) as owner`);

  return rows[0]?.owner ? accessToken : null;
}
