import { z } from "zod";

import { authorizeIngest, bearerOf, deliver } from "@/app/api/webhooks/respond";
import { webhookPayloadSchema } from "@/lib/validation/webhook";

// The caller is iPhone Shortcuts or a bridge, never the app UI; runs on Node
// (the resolver and ingest are server-only) and re-authenticates every hit.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  // Resolve and throttle before parsing, so an unauthorized or over-limit
  // caller is rejected without the cost of reading the body.
  const cred = await authorizeIngest(bearerOf(request));
  if (cred instanceof Response) return cred;

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

  return deliver(cred, parsed.data);
}
