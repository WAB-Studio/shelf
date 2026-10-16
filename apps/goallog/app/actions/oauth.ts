"use server";

import { sql } from "drizzle-orm";
import { headers } from "next/headers";

import { env } from "@/lib/env";
import { issueCode } from "@/lib/oauth/grants";
import { clientFromMetadataUrl } from "@/lib/oauth/client-metadata";
import { redirectAllowed } from "@/lib/oauth/clients";
import { getPerson, withGoalsDb } from "@/lib/session";
import { authorizationErrorKey, authorizationRequestSchema, type AuthorizationRequest } from "@/lib/validation/oauth";
import { type MessageKey } from "@/i18n/translator";

export type ConsentResult = { ok: true; redirectTo: string } | { ok: false; error: MessageKey };

type KnownClient = { id: string; redirectUris: string[] };

const siteUrl = () => env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");

// A client named by its metadata document is fetched and registered here; any
// other id is looked up. Unknown to both is `null`.
async function findClient(clientId: string, redirectUri: string): Promise<KnownClient | null> {
  if (clientId.startsWith("https://")) return clientFromMetadataUrl(clientId, await headers(), {}, { redirectUri });

  const rows = await withGoalsDb((tx) =>
    tx.execute<{ id: string; redirect_uris: string[] }>(sql`
      select id, redirect_uris from goals.oauth_clients where id = ${clientId}::uuid`),
  );

  return rows.length === 0 ? null : { id: rows[0].id, redirectUris: rows[0].redirect_uris };
}

type Checked =
  | { ok: true; request: AuthorizationRequest; client: KnownClient; personId: string }
  | { ok: false; error: MessageKey };

// The redirect target is only ever one the client registered: the error
// redirect is as much an open redirect as the success one.
async function check(input: unknown): Promise<Checked> {
  const failure = authorizationErrorKey(input, siteUrl());
  if (failure) return { ok: false, error: failure };
  const request = authorizationRequestSchema(siteUrl()).parse(input);

  const person = await getPerson();
  if (!person) return { ok: false, error: "oauth.errors.signedOut" };

  const client = await findClient(request.client_id, request.redirect_uri);
  if (!client) return { ok: false, error: "oauth.errors.clientUnknown" };
  if (!redirectAllowed(client, request.redirect_uri)) return { ok: false, error: "oauth.errors.redirectMismatch" };

  return { ok: true, request, client, personId: person.id };
}

function backTo(request: AuthorizationRequest, params: Record<string, string>): string {
  const url = new URL(request.redirect_uri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (request.state !== undefined) url.searchParams.set("state", request.state);

  return url.toString();
}

/**
 * Issues a code for the signed-in person and returns where to send them (RP-60).
 * The connection's name is the client's, set where the code is exchanged. Not a tool.
 */
export async function approveAuthorization(input: unknown): Promise<ConsentResult> {
  const checked = await check(input);
  if (!checked.ok) return checked;
  const { request, client, personId } = checked;

  const code = await withGoalsDb((tx) =>
    issueCode(tx, {
      personId,
      clientId: client.id,
      challenge: request.code_challenge,
      redirectUri: request.redirect_uri,
      resource: request.resource,
    }),
  );

  return { ok: true, redirectTo: backTo(request, { code, iss: siteUrl() }) };
}

/** Sends the person back to a registered client with `access_denied`; no code is written. */
export async function denyAuthorization(input: unknown): Promise<ConsentResult> {
  const checked = await check(input);
  if (!checked.ok) return checked;

  return { ok: true, redirectTo: backTo(checked.request, { error: "access_denied", iss: siteUrl() }) };
}
