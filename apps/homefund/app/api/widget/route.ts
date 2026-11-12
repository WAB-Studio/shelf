import { resolveWebhookCredential } from "@/db/queries/webhook-credentials";
import { getWidgetSummary } from "@/db/queries/widget-summary";
import { actAsCredentialOwner } from "@/db/session";

export const runtime = "nodejs";

const BEARER = /^Bearer\s+(\S+)\s*$/i;

const REFUSED = { "Cache-Control": "no-store" };

// The iPhone widget's summary (RF-215). Only a key minted for the widget opens it: a webhook's or
// Claude's never does, and no cookie is read. An absent, unknown, revoked or foreign key all answer the
// same 401, so a key's state never leaks. The summary may sit five minutes in the phone's cache.
export async function GET(request: Request): Promise<Response> {
  const token = request.headers.get("authorization")?.match(BEARER)?.[1];
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401, headers: REFUSED });

  const credential = await resolveWebhookCredential(token, "widget");
  if (credential === null) return Response.json({ error: "unauthorized" }, { status: 401, headers: REFUSED });
  if (credential.throttled) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...REFUSED, "Retry-After": "60" } });
  }

  try {
    const summary = await actAsCredentialOwner(credential.ownerUserId, () => getWidgetSummary());
    return Response.json(summary, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch {
    // Never the driver's message: it carries the query.
    console.error("widget summary failed", { credentialOwner: credential.ownerUserId });
    return Response.json({ error: "unexpected" }, { status: 500, headers: REFUSED });
  }
}
