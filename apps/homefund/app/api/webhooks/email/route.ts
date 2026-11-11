import { authorizeIngest, bearerOf, deliver } from "@/app/api/webhooks/respond";
import { env } from "@/lib/env";
import type { ResolvedWebhookCredential } from "@/db/queries/webhook-credentials";
import { classifyBankEmail } from "@/lib/ingest/classify";
import {
  emailToMessage,
  emailWords,
  hasBody,
  keyInPayloads,
  readInboundEmail,
  verifySvixSignature,
  type InboundEmail,
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

// The message the email carries, as one more delivery of the credential the key opened; one that
// reports no movement lands rejected (RF-195).
function finish(
  cred: ResolvedWebhookCredential,
  email: InboundEmail,
  externalRef?: string,
): Promise<Response> | Response {
  const parsed = webhookPayloadSchema.safeParse({
    text: emailToMessage(email),
    external_ref: externalRef,
  });
  if (!parsed.success) return Response.json({ error: "invalid_payload" }, { status: 422 });
  // Judged on the whole email, before the message is cut to the schema's ceiling (RF-195).
  const verdict = classifyBankEmail(emailWords(email));
  return deliver(cred, parsed.data, verdict.movement ? undefined : verdict.reason);
}

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("svix-signature");

  // A bearer caller is resolved before its body is read, as on the ingest route.
  if (signature === null) {
    const cred = await authorizeIngest(bearerOf(request));
    if (cred instanceof Response) return cred;
    const email = readInboundEmail(parseJson(await request.text()));
    if (email === null) return Response.json({ error: "invalid_payload" }, { status: 422 });
    return finish(cred, email);
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

  // The key is usually in the event's `to`, so a revoked one never costs a call to Resend;
  // an auto-forward leaves it only in the headers the full email carries.
  const eventKey = keyInPayloads(event);
  let cred = eventKey ? await authorizeIngest(eventKey) : null;
  if (cred instanceof Response) return cred;

  const received = hasBody(email) ? null : await fetchReceivedEmail(email.emailId);
  const full = received === null ? email : readInboundEmail(received);
  // A body that did not come back answers 503, so Svix retries instead of storing the subject alone.
  if (!full || !hasBody(full)) {
    return Response.json({ error: "body_unavailable" }, { status: 503 });
  }

  cred ??= await authorizeIngest(keyInPayloads(received));
  if (cred instanceof Response) return cred;

  // Resend's id as the reference: a Svix retry is one delivery, two alerts worded alike are two.
  return finish(cred, { ...full, subject: full.subject || email.subject }, email.emailId);
}
