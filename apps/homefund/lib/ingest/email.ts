import { createHmac, timingSafeEqual } from "node:crypto";

// RF-187: a forwarded bank email becomes the `text` of one ingest delivery.

// The ingest schema's own ceiling on `text`.
const MAX_MESSAGE_LENGTH = 320;
// Svix, which signs Resend's webhooks, refuses a timestamp older or newer than this.
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type InboundEmail = {
  emailId: string | null;
  subject: string;
  text: string;
  html: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Reads Resend's `email.received` event (`{ type, data }`) or a flat
 * `{ subject, text, html }`; null when the body is not an object.
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
    subject: asString(data.subject),
    text: asString(data.text),
    html: asString(data.html),
  };
}

export function hasBody(email: InboundEmail): boolean {
  return Boolean(email.text.trim() || email.html.trim());
}

// A key as an address's local part or plus tag: `whk_` and 43 base64url characters, then `@`.
const ADDRESSED_KEY = /(?:^|[^A-Za-z0-9_-])(whk_[A-Za-z0-9_-]{43})@/;

/**
 * The webhook key anywhere the payloads carry a recipient: `to`, `cc`, or a header
 * such as `X-Forwarded-To` or `Delivered-To`, which is where an auto-forward
 * leaves it when `To` still names the person.
 */
export function keyInPayloads(...payloads: unknown[]): string | null {
  for (const payload of payloads) {
    const key = JSON.stringify(payload ?? null).match(ADDRESSED_KEY)?.[1];
    if (key) return key;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", dollar: "$", quot: '"', apos: "'", lt: "<", gt: ">",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
};

function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => ENTITIES[name] ?? " ");
}

// What opens the header block a mail client writes above a forwarded message, and its lines.
const FORWARD_OPENER =
  /^(-{2,}.*-{2,}|(begin forwarded message|inicio del mensaje reenviado):?|(de|from)\s*:.*)$/i;
const FORWARD_HEADER = /^(de|from|para|to|asunto|subject|fecha|date|enviado|sent|cc)\s*:/i;
// Where a bank's message names its amount: «$52.300», «COP 9.100,00».
const AMOUNT_MARK = /\$\s?\d|COP\s?\d/i;
// Context kept ahead of the amount when the message must be cut.
const LEAD_BEFORE_AMOUNT = 120;

// Drops each forward header block: its opener and the header lines up to the first blank line.
function withoutForwardHeaders(lines: string[]): string[] {
  const kept: string[] = [];
  let inHeader = false;
  for (const line of lines) {
    if (line === "") inHeader = false;
    else if (FORWARD_OPENER.test(line)) inHeader = true;
    else if (!(inHeader && FORWARD_HEADER.test(line))) kept.push(line);
  }
  return kept;
}

/**
 * The bank's words, one line, at most what the ingest schema takes: the subject,
 * then the body without forward headers, quote marks or markup. A longer message
 * is cut around its first amount.
 */
export function emailToMessage(email: Pick<InboundEmail, "subject" | "text" | "html">): string {
  const body = email.text.trim() ? email.text : htmlToText(email.html);
  const subject = email.subject.replace(/^\s*((fwd?|rv|re)\s*:\s*)+/i, "").trim();
  const lines = withoutForwardHeaders(
    body.split(/\r?\n/).map((line) => line.replace(/^(\s*>)+/, "").trim()),
  );
  const message = [subject, ...lines].join(" ").replace(/\s+/g, " ").trim();
  if (message.length <= MAX_MESSAGE_LENGTH) return message;

  const amountAt = message.search(AMOUNT_MARK);
  const from = amountAt < 0 ? 0 : Math.max(0, amountAt - LEAD_BEFORE_AMOUNT);
  return message.slice(from, from + MAX_MESSAGE_LENGTH).trim();
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
