import { z } from "zod";

import { recordIngestDelivery } from "@/db/queries/webhook-ingest";
import { resolveWebhookCredential } from "@/db/queries/webhook-credentials";
import { webhookPayloadSchema } from "@/lib/validation/webhook";

// The caller is iPhone Shortcuts or a bridge, never the app UI; runs on Node
// (the resolver and ingest are server-only) and re-authenticates every hit.
export const runtime = "nodejs";

const BEARER_PREFIX = "Bearer ";

export async function POST(request: Request): Promise<Response> {
  // An unknown, revoked or absent token all read identically: a generic 401.
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = header.slice(BEARER_PREFIX.length);

  // Resolve and throttle before parsing, so an unauthorized or over-limit
  // caller is rejected without the cost of reading the body.
  const cred = await resolveWebhookCredential(token, "ingest");
  if (cred === null) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (cred.throttled) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_payload", fields: z.flattenError(parsed.error).fieldErrors },
      { status: 422 },
    );
  }

  try {
    const result = await recordIngestDelivery({
      ownerUserId: cred.ownerUserId,
      credentialId: cred.credentialId,
      defaultAccountId: cred.defaultAccountId,
      defaultCategoryId: cred.defaultCategoryId,
      payload: parsed.data,
    });

    return Response.json(
      {
        deliveryId: result.deliveryId,
        status: result.status,
        duplicate: result.duplicate,
      },
      { status: 200 },
    );
  } catch {
    // Never the payload text: a bank SMS must not reach the server log.
    console.error("webhook ingest failed", {
      credentialOwner: cred.ownerUserId,
    });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }
}
