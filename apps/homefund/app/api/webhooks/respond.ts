import "server-only";

import { recordIngestDelivery } from "@/db/queries/webhook-ingest";
import {
  resolveWebhookCredential,
  type ResolvedWebhookCredential,
} from "@/db/queries/webhook-credentials";
import type { WebhookPayloadInput } from "@/lib/validation/webhook";

// As `/mcp` reads it: any case, any spacing, a header typed by hand in an iOS Shortcut included.
const BEARER = /^Bearer\s+(\S+)\s*$/i;

export function bearerOf(request: Request): string | null {
  return request.headers.get("authorization")?.match(BEARER)?.[1] ?? null;
}

/**
 * The credential an ingest key opens, or the answer that refuses it: an absent,
 * unknown or revoked key all read the same generic 401, an over-limit one 429.
 */
export async function authorizeIngest(
  token: string | null,
): Promise<ResolvedWebhookCredential | Response> {
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  const cred = await resolveWebhookCredential(token, "ingest");
  if (cred === null) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (cred.throttled) return Response.json({ error: "rate_limited" }, { status: 429 });
  return cred;
}

// Stores the delivery as a pending proposal (RF-90) and answers its id and status.
export async function deliver(
  cred: ResolvedWebhookCredential,
  payload: WebhookPayloadInput,
): Promise<Response> {
  try {
    const result = await recordIngestDelivery({
      ownerUserId: cred.ownerUserId,
      credentialId: cred.credentialId,
      defaultAccountId: cred.defaultAccountId,
      defaultCategoryId: cred.defaultCategoryId,
      payload,
    });

    return Response.json(
      { deliveryId: result.deliveryId, status: result.status, duplicate: result.duplicate },
      { status: 200 },
    );
  } catch {
    // Never the payload text: a bank message must not reach the server log.
    console.error("webhook ingest failed", { credentialOwner: cred.ownerUserId });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }
}
