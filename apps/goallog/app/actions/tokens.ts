"use server";

import { revalidatePath } from "next/cache";

import { sql } from "drizzle-orm";

import { issueKey } from "@/lib/mcp/tokens";
import { getPerson, withGoalsDb } from "@/lib/session";
import {
  createTokenSchema,
  revokeTokenSchema,
  type CreateTokenInput,
  type RevokeTokenInput,
} from "@/lib/validation/token";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";

export type CreateAccessTokenResult =
  | { ok: true; id: string; key: string; hint: string }
  | { ok: false; error: MessageKey };
export type RevokeAccessTokenResult = { ok: true } | { ok: false; error: MessageKey };

/**
 * Mints a key for the signed-in person (RP-38). The clear key leaves in this
 * return value alone; the database keeps its hash. `access_tokens` has no
 * unique index on (user_id, name), so a key of the same name that still opens (neither revoked nor lapsed) is looked
 * for first in the same transaction. Two concurrent creations could still both
 * pass: the name is a label, not an identity.
 * Not a tool: an AI never mints a key.
 */
export async function createAccessToken(input: CreateTokenInput): Promise<CreateAccessTokenResult> {
  const parsed = createTokenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "connections.errors.signedOut" };

  try {
    const issued = await withGoalsDb(async (tx) => {
      const taken = await tx.execute(sql`
        select 1 from goals.access_tokens
        where user_id = ${person.id} and name = ${parsed.data.name}
          and goals.access_token_lapses_at(kind, last_used_at, created_at, expires_at, revoked_at) > now()
        limit 1`);
      if (taken.length > 0) throw new NamedError("connections.errors.nameTaken");

      return issueKey(tx, person.id, parsed.data.name);
    });
    revalidatePath("/conexiones");
    return { ok: true, ...issued };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

/**
 * Revokes one key or connection of the signed-in person (RP-38). The policy
 * `access_tokens_update_self` already hides another person's row and a revoked
 * one, so zero rows is «not yours» and «already revoked» alike. Not a tool.
 */
export async function revokeAccessToken(input: RevokeTokenInput): Promise<RevokeAccessTokenResult> {
  const parsed = revokeTokenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "connections.errors.signedOut" };

  const rows = await withGoalsDb((tx) =>
    tx.execute(sql`
      update goals.access_tokens set revoked_at = now()
      where id = ${parsed.data.tokenId} and revoked_at is null
      returning id`),
  );
  if (rows.length === 0) return { ok: false, error: "connections.errors.notFound" };

  revalidatePath("/conexiones");
  return { ok: true };
}
