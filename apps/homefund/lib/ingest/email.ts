import { createHmac, timingSafeEqual } from "node:crypto";

// RF-187: a forwarded bank email becomes the `text` of one ingest delivery.

// The ingest schema's own ceiling on `text`.
const MAX_MESSAGE_LENGTH = 320;
// Svix, which signs Resend's webhooks, refuses a timestamp older or newer than this.
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type InboundEmail = {
  emailId: string | null;
  to: string[];
  subject: string;
  text: string;
  html: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asAddresses(value: unknown): string[] {
  if (typeof value === "string") return value.split(",");
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === "string"
        ? [item]
        : item && typeof item === "object" && "address" in item
          ? [asString(item.address)]
          : [],
    );
  }
  return [];
}

/**
 * Reads Resend's `email.received` event (`{ type, data }`) or a flat
 * `{ from, to, subject, text, html }`; null when the body is neither.
 */
export function readInboundEmail(raw: unknown): InboundEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw as Record<string, unknown>;
  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : envelope;

  return {
    emailId: asString(data.email_id) || null,
    to: asAddresses(data.to).map((a) => a.trim()).filter(Boolean),
    subject: asString(data.subject),
    text: asString(data.text),
    html: asString(data.html),
  };
}

/**
 * The webhook key a recipient carries: `whk_…@domain`, or `name+whk_…@domain`.
 * The first recipient that carries one wins.
 */
export function keyFromAddresses(addresses: string[]): string | null {
  for (const address of addresses) {
    // «Name <local@domain>» keeps only what is inside the brackets.
    const bare = address.match(/<([^>]+)>/)?.[1] ?? address;
    const local = bare.trim().split("@")[0] ?? "";
    const key = local.split("+").find((part) => part.startsWith("whk_"));
    if (key) return key;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&[a-z#0-9]+;/gi, " ");
}

// The header block a mail client writes above a forwarded message, in Spanish and English.
const FORWARD_LINE =
  /^\s*(-{2,}.*-{2,}|(de|from|para|to|asunto|subject|fecha|date|enviado|sent|cc)\s*:.*)$/i;

/**
 * The bank's words, one line, at most what the ingest schema takes: the
 * subject, then the body without the forward header, quote marks or blank lines.
 */
export function emailToMessage(email: Pick<InboundEmail, "subject" | "text" | "html">): string {
  const body = email.text.trim() ? email.text : htmlToText(email.html);
  const subject = email.subject.replace(/^\s*((fwd?|rv|re)\s*:\s*)+/i, "").trim();

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*>)+/, "").trim())
    .filter((line) => line !== "" && !FORWARD_LINE.test(line));

  const message = [subject, ...lines].join(" ").replace(/\s+/g, " ").trim();

  return message.slice(0, MAX_MESSAGE_LENGTH).trim();
}

/**
 * Svix's signature, which Resend sends: HMAC-SHA256 over `id.timestamp.body`
 * with the base64 secret after `whsec_`, any of the space-separated `v1,` values.
 */
export function verifySvixSignature({
  secret,
  id,
  timestamp,
  signature,
  body,
  nowSeconds,
}: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds: number;
}): boolean {
  if (!id || !timestamp || !signature) return false;
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
