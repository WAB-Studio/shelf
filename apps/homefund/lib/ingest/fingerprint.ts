import { createHash } from "node:crypto";

// One pass over a bank SMS yields the shape the review queue remembers (RF-92),
// the idempotency key the ingest falls back on (RF-90) and the merchant span a
// category memory hangs on (RF-93). It is pure: no DB, no async, no side effect.

// The stability clause: the mask feeds the shape hash, and the merchant rules
// only read the mask's output — they never change which tokens are masked.
// Refining the merchant extractor must leave every `shapeHash` byte-identical,
// or every shape a person already approved or silenced is orphaned and the
// queue starts asking again for messages it had already learned.

// The honesty about reach: the anchors are Spanish and tuned to this corpus.
// The two card templates and Banco de Bogotá's yield the merchant, the income
// template yields the sender's name and the Bre-b one the recipient's — both
// legitimate memory keys. T1 and T6 yield null and always will: the QR template
// names no counterparty at all, only a key number, so a QR payment can never
// carry a merchant memory. A bank or a language these anchors do not cover also
// yields null, which costs a prefill and never invents a wrong one.

// A token survives the mask only as a plain lowercase word, accents included.
// Anything else — a capital, a digit, an internal symbol, an empty remainder —
// is a proper name, an amount, an account tail, a date or a time, and is masked.
const KEPT_TOKEN = /^[a-záéíóúüñ]+$/;

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

const MASK = "@";

// The words that introduce the counterparty in this corpus: `en BOLD CO ONLINE`,
// `de CARLOS NIETO`, `a REFRESCOS Y COMESTIBLES COLOMBIA`.
const ANCHORS = new Set(["en", "de", "a"]);

// A merchant name never crosses a clause boundary: `¿` opens the banks' help
// question and `:` closes their header, so a run stops before either of them.
// `,`, `.` and `?` close the name itself, so that token still belongs to it.
const OPENS_CLAUSE = /^¿/;
const CLOSES_HEADER = /:$/;
const CLOSES_NAME = /[,.?]$/;

const HAS_LETTER = /\p{L}/u;

const MAX_LABEL_LENGTH = 120;

interface Token {
  original: string;
  stripped: string;
  kept: boolean;
}

interface Merchant {
  key: string;
  label: string;
}

interface MessageFingerprint {
  shapeHash: string;
  contentHash: string;
  skeleton: string;
  merchant: Merchant | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter((original) => original.length > 0)
    .map((original) => {
      const stripped = original.replace(EDGE_PUNCTUATION, "");
      return { original, stripped, kept: KEPT_TOKEN.test(stripped) };
    });
}

// Adjacent masked tokens collapse into one marker, so a two-word merchant and a
// four-word one reach the same skeleton.
function buildSkeleton(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.kept) {
      parts.push(token.stripped);
    } else if (parts[parts.length - 1] !== MASK) {
      parts.push(MASK);
    }
  }
  return parts.join(" ");
}

// The run of masked tokens starting at `start`, cut where a clause boundary says
// the name ends. Returns an empty array when the boundary lands on the first token.
function readRun(tokens: Token[], start: number): Token[] {
  const run: Token[] = [];
  for (let index = start; index < tokens.length && !tokens[index].kept; index += 1) {
    const token = tokens[index];
    if (OPENS_CLAUSE.test(token.original) || CLOSES_HEADER.test(token.original)) {
      break;
    }
    run.push(token);
    if (CLOSES_NAME.test(token.original)) {
      break;
    }
  }
  return run;
}

// `RAPPI COLOMBIA*DL` and `RAPPI COLOMBIA DL` are one merchant; the key is what
// the memory matches on, the label is what the person reads.
function merchantKey(label: string): string {
  return label
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function findMerchant(tokens: Token[]): Merchant | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1];
    if (tokens[index].kept || !previous.kept || !ANCHORS.has(previous.stripped)) {
      continue;
    }

    const run = readRun(tokens, index);
    if (run.length === 0) {
      continue;
    }

    const last = run[run.length - 1];
    const words = run.map((token) => token.original);
    words[words.length - 1] = CLOSES_NAME.test(last.original)
      ? last.original.replace(/[^\p{L}\p{N}]+$/u, "")
      : last.original;

    const label = words.join(" ").slice(0, MAX_LABEL_LENGTH);
    // An account number, a Bre-b key or a date reaches here as a run too; only a
    // run carrying a letter names anybody.
    if (!HAS_LETTER.test(label)) {
      continue;
    }

    return { key: merchantKey(label), label };
  }

  return null;
}

export function fingerprintMessage(text: string): MessageFingerprint {
  const tokens = tokenize(text);
  const skeleton = buildSkeleton(tokens);

  return {
    shapeHash: sha256(skeleton),
    // Hashed over the raw text as it arrived, before any trimming or masking, so
    // the same SMS re-forwarded lands on the same reference — a different hash
    // over different input from `shapeHash`, never derived from it.
    contentHash: sha256(text),
    skeleton,
    merchant: findMerchant(tokens),
  };
}
