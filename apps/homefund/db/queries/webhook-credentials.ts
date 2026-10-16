import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { insertRow } from "@/db/insert-row";
import { listAccounts } from "@/db/queries/accounts";
import { listScopedCategories } from "@/db/queries/categories";
import type { CategoryNode } from "@/db/queries/categories";
import { webhookCredentials } from "@/db/schema";
import { requireUser, withUserDb } from "@/db/session";

// The bearer a webhook presents, and the SHA-256 of it the row keeps. Only the
// hash is ever stored, so a raw token exists in exactly two places: this file's
// `issue` return and `resolve`'s input. It is shown once and never re-derivable.
function tokenHashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type IssueWebhookCredentialArgs = {
  name: string;
  defaultAccountId: string | null;
  defaultCategoryId: string | null;
  rateLimitPerMin?: number;
};

/**
 * Mint a credential and hand back its raw bearer once (RF-86). The token is a
 * `whk_`-prefixed base64url of 32 random bytes; only its hash lands in the row,
 * so this return is the single moment the plaintext exists. One round trip; the
 * owner is trigger-stamped from the session, never named here.
 */
export async function issueWebhookCredential({
  name,
  defaultAccountId,
  defaultCategoryId,
  rateLimitPerMin = 60,
}: IssueWebhookCredentialArgs): Promise<{ id: string; token: string }> {
  const token = `whk_${randomBytes(32).toString("base64url")}`;
  const tokenHash = tokenHashOf(token);

  return withUserDb(async (tx) => {
    // `owner_user_id` is stamped by the owner trigger and absent from the
    // INSERT grant.
    const [row] = await insertRow(
      tx,
      webhookCredentials,
      { name, tokenHash, defaultAccountId, defaultCategoryId, rateLimitPerMin },
      { returning: { id: webhookCredentials.id } },
    );

    return { id: row.id, token };
  });
}

export type WebhookCredentialRow = {
  id: string;
  name: string;
  defaultAccountId: string | null;
  defaultCategoryId: string | null;
  rateLimitPerMin: number;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

// The caller's own credentials, newest first. `token_hash` is never selected —
// it is not even granted to `authenticated` — and the audit viewer leaves the
// snapshot that holds it in the table, so no read path carries it.
export async function listWebhookCredentials(): Promise<WebhookCredentialRow[]> {
  return withUserDb(async (tx) =>
    tx
      .select({
        id: webhookCredentials.id,
        name: webhookCredentials.name,
        defaultAccountId: webhookCredentials.defaultAccountId,
        defaultCategoryId: webhookCredentials.defaultCategoryId,
        rateLimitPerMin: webhookCredentials.rateLimitPerMin,
        lastUsedAt: webhookCredentials.lastUsedAt,
        revokedAt: webhookCredentials.revokedAt,
        createdAt: webhookCredentials.createdAt,
      })
      .from(webhookCredentials)
      .orderBy(desc(webhookCredentials.createdAt)),
  );
}

// Stamp the revocation; the affected-row count reports whether the owner policy
// admitted it (RF-85). A resolve past this point yields no row.
export async function revokeWebhookCredential({
  id,
}: {
  id: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(webhookCredentials)
      .set({ revokedAt: sql`now()` })
      .where(eq(webhookCredentials.id, id))
      .returning({ id: webhookCredentials.id });

    return rows.length > 0;
  });
}

export type ResolvedWebhookCredential = {
  credentialId: string;
  ownerUserId: string;
  defaultAccountId: string | null;
  defaultCategoryId: string | null;
  throttled: boolean;
};

/**
 * The identified-system read (RNF-04): resolve a raw token to its owner and
 * defaults over the BASE `db` connection, which connects as the resolver's
 * owner role — the only role that may execute it. No user session, no
 * `withUserDb`. The resolver returns no row for an unknown or revoked token,
 * and reports `throttled` so the route alone maps it to 429.
 */
export async function resolveWebhookCredential(
  token: string,
): Promise<ResolvedWebhookCredential | null> {
  const tokenHash = tokenHashOf(token);

  const rows = await db.execute<{
    id: string;
    owner_user_id: string;
    default_account_id: string | null;
    default_category_id: string | null;
    throttled: boolean;
  }>(
    sql`select id, owner_user_id, default_account_id, default_category_id, throttled
      from private.resolve_webhook_credential(${tokenHash})`,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    credentialId: row.id,
    ownerUserId: row.owner_user_id,
    defaultAccountId: row.default_account_id,
    defaultCategoryId: row.default_category_id,
    throttled: row.throttled,
  };
}

// What the issue form offers as a credential's fallbacks (RF-86).
export type WebhookCredentialOptions = {
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string; kind: "income" | "expense" }[];
};

// A node and its children as flat pickable rows; a child inherits the node's kind,
// which the payload's `direction` has to be able to match.
function flattenCategories(
  nodes: CategoryNode[],
): { id: string; name: string; kind: "income" | "expense" }[] {
  return nodes
    .flatMap((node) => [
      { id: node.id, name: node.name, kind: node.kind },
      ...node.children.map((child) => ({
        id: child.id,
        name: child.name,
        kind: node.kind,
      })),
    ])
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The defaults an issue form may offer, in one fan-out. Both category scopes come
 * back from one statement, the caller's group resolved inside it, so nothing is
 * chained ahead of the fan-out and a personal-only caller pays no group read.
 *
 * The account list is narrowed to what an ingest under this owner could write:
 * their own personal accounts and the group's shared ones. Another member's
 * personal account is dropped because a default pointing there makes every
 * delivery fail. The narrowing is presentation of the policy, never the policy —
 * RLS is what actually refuses an out-of-scope write.
 */
export async function getWebhookCredentialOptions(): Promise<WebhookCredentialOptions> {
  const user = await requireUser();

  const [accounts, categories] = await Promise.all([
    listAccounts({ archived: false }),
    listScopedCategories(user.id),
  ]);

  return {
    accounts: accounts
      .filter(
        (account) =>
          account.ownerUserId === user.id ||
          (account.groupId !== null && account.isShared),
      )
      .map((account) => ({ id: account.id, name: account.name })),
    categories: [
      ...flattenCategories(categories.filter((node) => node.scope === "personal")),
      ...flattenCategories(categories.filter((node) => node.scope === "group")),
    ],
  };
}
