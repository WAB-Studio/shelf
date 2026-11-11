import { recordIngestDelivery } from "@/db/queries/webhook-ingest";
import { resolveWebhookCredential } from "@/db/queries/webhook-credentials";
import { env } from "@/lib/env";
import {
  emailToMessage,
  keyFromAddresses,
  readInboundEmail,
  verifySvixSignature,
  type InboundEmail,
} from "@/lib/ingest/email";
import { webhookPayloadSchema } from "@/lib/validation/webhook";

// RF-187: a forwarded bank email lands in the inbox as one more delivery (RF-90).
// Two callers: Resend Inbound, signed with Svix, whose recipient address carries
// the webhook key; or any forwarder that sends the key as a bearer.
export const runtime = "nodejs";

const BEARER_PREFIX = "Bearer ";
const RESEND_RECEIVED_EMAIL_URL = "https://api.resend.com/emails/receiving/";

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// Resend's event carries no body: it is read back by id, with the account's API key.
async function withBody(email: InboundEmail): Promise<InboundEmail> {
  if (email.text.trim() || email.html.trim() || !email.emailId || !env.RESEND_API_KEY) {
    return email;
  }
  const response = await fetch(
    `${RESEND_RECEIVED_EMAIL_URL}${encodeURIComponent(email.emailId)}`,
    { headers: { authorization: `Bearer ${env.RESEND_API_KEY}` } },
  );
  if (!response.ok) return email;
  const full = readInboundEmail(await response.json());
  return full ? { ...email, text: full.text, html: full.html } : email;
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const email = readInboundEmail(raw);
  if (email === null) {
    return Response.json({ error: "invalid_payload" }, { status: 422 });
  }

  // An unsigned call, a bad signature and an unknown key all read the same 401.
  let token: string | null;
  const signature = request.headers.get("svix-signature");
  if (signature !== null) {
    const signed =
      env.INBOUND_EMAIL_WEBHOOK_SECRET !== undefined &&
      verifySvixSignature({
        secret: env.INBOUND_EMAIL_WEBHOOK_SECRET,
        id: request.headers.get("svix-id"),
        timestamp: request.headers.get("svix-timestamp"),
        signature,
        body,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
    token = signed ? keyFromAddresses(email.to) : null;
  } else {
    const header = request.headers.get("authorization");
    token = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null;
  }
  if (!token) return unauthorized();

  const cred = await resolveWebhookCredential(token, "ingest");
  if (cred === null) return unauthorized();
  if (cred.throttled) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = webhookPayloadSchema.safeParse({
    text: emailToMessage(await withBody(email)),
  });
  if (!parsed.success) {
    return Response.json({ error: "invalid_payload" }, { status: 422 });
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
      { deliveryId: result.deliveryId, status: result.status, duplicate: result.duplicate },
      { status: 200 },
    );
  } catch {
    // Never the message: a bank email must not reach the server log.
    console.error("email ingest failed", { credentialOwner: cred.ownerUserId });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }
}
