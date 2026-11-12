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

// Filler a marketing email pads its preheader with, and the emoji a subject carries.
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u2060\ufeff]/gu;
const PICTOGRAPH = /[\p{Extended_Pictographic}\ufe0f]/gu;
// A plain-text part prints an image as «alt [url]» and a link as «label [url]», «<url>» or «(url)»;
// the alt is up to two words glued to the bracket.
const IMAGE_RESIDUE =
  /(?:[\p{L}\p{N}_-]+ ){0,2}[\p{L}\p{N}_-]+ ?\[https?:\/\/[^\]\s]+\.(?:png|jpe?g|gif|svg|webp)[^\]\s]*\]/giu;
const LINK_RESIDUE = /\s?\[(?:https?:\/\/|mailto:)?[^\]\s]*[:@/.][^\]\s]*\]|<https?:\/\/[^>\s]*>|\(\s*https?:\/\/[^)\s]*\s*\)|\bhttps?:\/\/\S+|%[a-z]+%/giu;

/** The text without images, links, invisible filler and emoji: what a person would read in the mail. */
function withoutResidue(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(PICTOGRAPH, "")
    .replace(IMAGE_RESIDUE, " ")
    .replace(LINK_RESIDUE, " ");
}

// The identifier a gateway puts in its subject: «[1091900964]», «[uuid]», «- ref. AB12».
const SUBJECT_REFERENCE = /\[[\w-]{6,}\]|\s-?\s*ref\.?\s+\S+/giu;

// What opens the header block a mail client writes above a forwarded message, and its lines.
const FORWARD_OPENER =
  /^(-{2,}.*-{2,}|(begin forwarded message|inicio del mensaje reenviado):?|(de|from)\s*:.*)$/i;
const FORWARD_HEADER = /^(de|from|para|to|asunto|subject|fecha|date|enviado|sent|cc)\s*:/i;
// Where a bank's message names its amount: «$52.300», «COP 9.100,00».
const AMOUNT_MARK = /\$\s?\d|COP\s?\d/i;
// Context kept ahead of the amount when the message must be cut.
const LEAD_BEFORE_AMOUNT = 120;
// A subject that only names the sender's channel adds nothing to the sentence below it.
const GENERIC_SUBJECT = /^(alertas? y notificaciones?|notificaci[oó]n(es)?|aviso|comprobante)$/i;
// The verb or phrase that opens the sentence saying what happened to the person's money.
const OPERATIVE_START = new RegExp(
  [
    "compraste", "pagaste", "transferiste", "recibiste", "retiraste", "te enviaron", "te transfirieron",
    "te consignaron", "hiciste un pago", "realizaste (?:una transferencia|un pago|un env[ií]o|un retiro)",
    "compra por \\$", "total pagado", "monto recibido", "se le acaba de pagar",
  ].join("|"),
  "iu",
);
// The sender's own label, which opens its sentence when it stands right before the verb.
const SENDER_LABEL = /(?:Bancolombia|Nequi|Davivienda|Lulo|\bNu)\s*:/u;
// Where the bank's operative sentence ends: its help line, its marketing line or its sign-off.
const OPERATIVE_END = new RegExp(
  [
    "si tienes dudas", "[¿]?dudas\\b", "si no fuiste", "si no reconoces", "estamos cerca", "siempre contigo",
    "siempre a tu lado", "a tu lado siempre", "con (?:bre-?b|llaves|c[oó]digo qr) es", "puedes ingresar",
    "controla tu dinero", "quieres ver", "tus gastos tienen", "para que enviar", "ll[aá]manos",
    "esto es un mensaje", "tu seguridad", "gracias por", "guarda el comprobante", "si decidiste",
    "si el correo no", "conoce los detalles",
  ].join("|"),
  "iu",
);
const MAX_OPERATIVE_LENGTH = 260;
// The most of a subject that stays ahead of the body when the message is cut.
const MAX_LEAD_LENGTH = 120;
// Between the subject and the body, so the description can stop where the subject does.
const LEAD_SEPARATOR = " — ";

// The sentence the bank's own words open with, from its label to its help line; null when no
// verb says what happened.
function operativeSentence(text: string): string | null {
  const anchor = OPERATIVE_START.exec(text);
  if (!anchor) return null;

  const before = text.slice(0, anchor.index);
  const boundary = Math.max(
    ...[...before.matchAll(/[.!?](?=\s|\p{Lu})/gu)].map((match) => match.index + 1),
    0,
  );
  const label = [...text.slice(boundary, anchor.index).matchAll(new RegExp(SENDER_LABEL, "gu"))].pop();
  const start = label ? boundary + label.index : anchor.index;

  const rest = text.slice(anchor.index + anchor[0].length);
  const end = rest.search(OPERATIVE_END);
  const stop = end < 0 ? rest.length : end;
  return text.slice(start, anchor.index + anchor[0].length + stop).trim().slice(0, MAX_OPERATIVE_LENGTH);
}

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

/** The subject without its forward prefixes and emoji, and the body as plain text without images or links. */
export function emailWords(email: Pick<InboundEmail, "subject" | "text" | "html">): {
  subject: string;
  body: string;
} {
  return {
    subject: withoutResidue(email.subject.replace(/^\s*((fwd?|rv|re)\s*:\s*)+/i, ""))
      .replace(SUBJECT_REFERENCE, " ")
      .replace(/^[\s:;-]*[:;]-?[)(dp]\s+/iu, "")
      .replace(/^[\s-]+|[\s:-]+$/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
    body: withoutResidue(email.text.trim() ? email.text : htmlToText(email.html)),
  };
}

// The words that fit `budget`, cut around the first amount and at a word boundary.
function fitAroundAmount(text: string, budget: number): string {
  if (text.length <= budget) return text;

  const amountAt = text.search(AMOUNT_MARK);
  let from = amountAt < 0 ? 0 : Math.max(0, amountAt - LEAD_BEFORE_AMOUNT);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    from = space < 0 ? from : space + 1;
  }
  return text.slice(from, from + budget).trim();
}

/**
 * The bank's words, one line, at most what the ingest schema takes: the subject (unless it only
 * names the channel), then the sentence that says what happened, without forward headers, quote
 * marks, markup, images or links. A body with no such sentence, or whose sentence names no amount,
 * is cut around its first amount; the subject stays.
 */
export function emailToMessage(email: Pick<InboundEmail, "subject" | "text" | "html">): string {
  const { subject, body } = emailWords(email);
  const lines = withoutForwardHeaders(
    body.split(/\r?\n/).map((line) => line.replace(/^(\s*>)+/, "").trim()),
  );
  const flat = lines.join(" ").replace(/\s+/g, " ").trim();
  const sentence = operativeSentence(flat);
  const words = sentence !== null && AMOUNT_MARK.test(sentence) ? sentence : flat;
  const lead = GENERIC_SUBJECT.test(subject) ? "" : subject.slice(0, MAX_LEAD_LENGTH);

  const separator = lead === "" ? "" : LEAD_SEPARATOR;
  return `${lead}${separator}${fitAroundAmount(words, MAX_MESSAGE_LENGTH - lead.length - separator.length)}`.trim();
}

// What a bank email wraps around the sentence a person acts on.
const GREETING = /¡?\bhola,?\s+[\p{L}\s.*]{1,60}[!.,:]/giu;
const SENDER_PREFIX =
  /^(?:(?:todo sali[oó] bien con tus movimientos|alertas? y notificaciones)\s*)?(?:Bancolombia|Nequi|Davivienda|Lulo|ecollect)\s*:\s*/iu;
// «WILSON, transferiste…» and «WILSON PARADA pagaste…»: the person's own name ahead of the verb.
const NAME_BEFORE_VERB =
  /^(?:\p{Lu}[\p{Lu}.]*,?\s+)+(?=(?:compraste|pagaste|transferiste|recibiste|retiraste)\b)/u;
// A subject that states the outcome and nothing else.
const STATUS_PHRASE =
  /^(?:¡?\s*(?:pago (?:exitoso|hecho)|env[ií]o con bre-?b exitoso|recibiste plata por bre-?b)\s*[!.]*\s*)+/iu;
// The date, the time and the identifiers the bank prints after the sentence.
const AFTER_SENTENCE =
  /,?\s+el\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$|\s+(?:Fecha|Hora|Referencia|REF:|TERM:|CUS|ID\.?\s+transacci[oó]n|Costo de|Estado:|Medio de pago|Origen|Destino|Los siguientes|Resumen)\b.*$/u;
// «en tu cuenta de Ahorros» says where an income landed; the account has its own field.
const LANDING_ACCOUNT = /\s+en tu cuenta\b.*$/iu;
// An amount the interpreter lifted out leaves its mark and its connector behind.
const STRAY_CURRENCY = /\b(?:COP|USD)\b(?!\s?\d)|(?<!\d)\$\s*(?!\d)/gu;
const DANGLING_CONNECTOR = /\bpor\s+(?=(?:en|a|con|desde|de)\b)/giu;
const REFERENCE_NUMBER = /\s#\d{5,}/gu;
// A full stop that ends a sentence, not one inside «S.A.» or «T.Cred».
const SENTENCE_END = /(?<!\b\p{Lu}(?:\.\p{Lu})*)[.!?]\s+(?=\p{Lu}|¿|¡)/u;
// A gateway's receipt names the business in a labelled field when its subject does not.
const LABELED_MERCHANT =
  /\b(?:(?:Empresa|Comercio)\s*:?|realizada en)\s+(.+?)(?=\s*,|\s+(?:Descripci[oó]n|Fecha|Valor|Referencia|CUS|NIT|M[eé]todo|Medio|Estado|Hora|ID|Pagador)\b|$)/u;

function oneSentence(segment: string): string {
  let text = segment.replace(STATUS_PHRASE, "").replace(SENDER_PREFIX, "").replace(NAME_BEFORE_VERB, "");
  const cut = SENTENCE_END.exec(text);
  if (cut) text = text.slice(0, cut.index);
  return text
    .replace(AFTER_SENTENCE, "")
    .replace(LANDING_ACCOUNT, "")
    .replace(STRAY_CURRENCY, " ")
    .replace(DANGLING_CONNECTOR, "")
    .replace(REFERENCE_NUMBER, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s¡—-]+|[\s,.:;!—-]+$/gu, "")
    .replace(/\s+(?:por|de|en|a|con)$/iu, "")
    .replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase("es"))
    .trim();
}

/**
 * The description of a bank email's proposal, from what the interpreter left once the amount was
 * lifted out: the subject's sentence (a receipt's subject names the business) or, when the subject
 * only states the outcome, the bank's operative sentence; without the bank's label, the person's
 * name, the date and time, the identifiers or its help line. A receipt that names the business in
 * a field adds it. It falls back to the whole text when nothing else is left.
 */
export function emailDescription(description: string): string {
  const text = description.replace(GREETING, " ").replace(/\s+/g, " ").trim();
  const first = text
    .split(LEAD_SEPARATOR)
    .map(oneSentence)
    .find((sentence) => sentence !== "");
  if (first === undefined) return description.trim();

  const merchant = LABELED_MERCHANT.exec(text)?.[1]?.trim();
  return merchant && !first.toLowerCase().includes(merchant.toLowerCase())
    ? `${first}${LEAD_SEPARATOR}${merchant}`
    : first;
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
