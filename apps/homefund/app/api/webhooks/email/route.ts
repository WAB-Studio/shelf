import { authorizeIngest, bearerOf, deliver } from "@/app/api/webhooks/respond";
import { env } from "@/lib/env";
import {
  emailToMessage,
  keyInPayloads,
  readInboundEmail,
  verifySvixSignature,
} from "@/lib/ingest/email";
import { webhookPayloadSchema } from "@/lib/validation/webhook";

// RF-187: a forwarded bank email lands in the inbox as one more delivery (RF-90).
// Two callers: Resend Inbound, signed with Svix, whose recipient carries the
// webhook key; or any forwarder that sends the key as a bearer.
export const runtime = "nodejs";

const RESEND_RECEIVED_EMAIL_URL = "https://api.resend.com/emails/receiving/";
const RESEND_TIMEOUT_MS = 5_000;

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Resend's event carries no body or headers: they are read back by id with the account's API key.
async function fetchReceivedEmail(emailId: string): Promise<unknown> {
  if (!env.RESEND_API_KEY) return null;
  try {
    const response = await fetch(`${RESEND_RECEIVED_EMAIL_URL}${encodeURIComponent(emailId)}`, {
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("svix-signature");

  // A bearer caller is resolved before its body is read, as on the ingest route.
  if (signature === null) {
    const cred = await authorizeIngest(bearerOf(request));
    if (cred instanceof Response) return cred;
    const email = readInboundEmail(parseJson(await request.text()));
    const parsed = webhookPayloadSchema.safeParse({ text: email && emailToMessage(email) });
    if (!parsed.success) return Response.json({ error: "invalid_payload" }, { status: 422 });
    return deliver(cred, parsed.data);
  }

  const body = await request.text();
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
  if (!signed) return Response.json({ error: "unauthorized" }, { status: 401 });

  const event = parseJson(body);
  const email = readInboundEmail(event);
  if (email === null || email.emailId === null) {
    return Response.json({ error: "invalid_payload" }, { status: 422 });
  }
  const hasBody = Boolean(email.text.trim() || email.html.trim());
  const received = hasBody ? null : await fetchReceivedEmail(email.emailId);
  const full = hasBody ? email : readInboundEmail(received);
  // A body that did not come back answers 503, so Svix retries instead of storing the subject alone.
  if (!full || !(full.text.trim() || full.html.trim())) {
    return Response.json({ error: "body_unavailable" }, { status: 503 });
  }

  const cred = await authorizeIngest(keyInPayloads(event, received));
  if (cred instanceof Response) return cred;

  const parsed = webhookPayloadSchema.safeParse({
    text: emailToMessage({ ...full, subject: full.subject || email.subject }),
    // Resend's id: a Svix retry is one delivery, two alerts worded alike are two.
    external_ref: email.emailId,
  });
  if (!parsed.success) return Response.json({ error: "invalid_payload" }, { status: 422 });
  return deliver(cred, parsed.data);
}
