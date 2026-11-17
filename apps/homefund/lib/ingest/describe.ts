import { emailMerchant } from "@/lib/ingest/email";
import { extractNumber } from "@/lib/ingest/recipient-number";

// A bank alert's description as a person would write it, from the alert's own words and whichever channel
// carried it (SMS, notification, shortcut or email). Pure: text in, description out; null when no shape fits.

// Spanish particles a title-cased name keeps in lowercase.
const PARTICLES = new Set(["de", "del", "la", "las", "los", "el", "y", "en", "a", "o", "u", "con", "por"]);
const UPPERCASE_WORD = /^[A-ZÁÉÍÓÚÑÜ]+$/u;
// A payment gateway's suffix on a business («RAPPI COLOMBIA*DL»): it names no one.
const GATEWAY_SUFFIX = /\*[A-Z0-9]{1,4}$/u;
const AMOUNT = String.raw`(?:COP\s?|\$\s?)?[\d.,]*`;
// Where a business or a person's name ends in a bank's sentence.
// A time of day or a card label also closes it: «en RAPPI RESTAURANTE 15:32. 12/11/2026 T.Cred *4521».
const NAME_END = String.raw`(?=\s+(?:con\s+(?:tu|la|el)|desde|por|el\s+\d+|a\s+las|\d{1,2}:\d{2}|T\.?\s?(?:cred|deb))\b|[,;]|\.(?:\s|$)|\s*$)`;
// A person's name as the bank prints it: capitals only.
const PERSON = String.raw`((?:[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ.'-]+\s*)+)`;

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A name the bank shouts in capitals, written as a person reads it («FONDO NACIONAL DEL AHORRO» → «Fondo Nacional del Ahorro»). */
export function readableName(raw: string): string {
  const name = raw.replace(/[\s.,;*]+$/u, "").replace(GATEWAY_SUFFIX, "").trim();
  if (name === "" || /\p{Ll}/u.test(name)) return name;

  return name
    .split(" ")
    .map((word, index) => {
      if (!UPPERCASE_WORD.test(word)) return word;
      const lower = word.toLocaleLowerCase("es");
      return index > 0 && PARTICLES.has(lower) ? lower : lower.replace(/^./u, (letter) => letter.toLocaleUpperCase("es"));
    })
    .join(" ");
}

function lastFour(digits: string): string {
  return digits.slice(-4);
}

type Shape = (text: string) => string | null;

// «Compraste COP80.800,00 en X con tu T.Cred *4872»: the business.
const purchase: Shape = (text) => {
  const match = new RegExp(String.raw`\bcompraste\s+${AMOUNT}\s*en\s+(.+?)${NAME_END}`, "iu").exec(text);
  return match ? readableName(match[1]) : null;
};

// A cash withdrawal at a cash machine: «Retiraste $300.000 en cajero…», «Retiro por $300.000», «Cajero … $300.000».
const WITHDRAWAL = /\b(?:retiraste|retiro\s+(?:por|de|en|exitoso)|cajero|atm)\b/iu;

/** Whether the message reports cash taken out at a cash machine, which moves money into the person's own cash. */
export function looksLikeCashWithdrawal(text: string): boolean {
  return WITHDRAWAL.test(text);
}

const withdrawal: Shape = (text) => (looksLikeCashWithdrawal(text) ? "Retiro en cajero" : null);

// «Bancolombia le informa Compra por $38.000 en RAPPI RESTAURANTE 15:32…» and «Compra aprobada por $52.300 en EXITO
// COLINA»: the noun form, with no «compraste».
const purchaseNoun: Shape = (text) => {
  const match = new RegExp(String.raw`\bcompra\s+(?:aprobada\s+)?por\s+${AMOUNT}\s*en\s+(.+?)${NAME_END}`, "iu").exec(text);
  return match ? readableName(match[1]) : null;
};

// «Pagaste en UBER TRIP»: a payment that names the business and no figure.
const paidAt: Shape = (text) => {
  const match = new RegExp(String.raw`\bpagaste\s+(?:${AMOUNT}\s*)?en\s+(.+?)${NAME_END}`, "iu").exec(text);
  return match ? readableName(match[1]) : null;
};

// Banco de Bogotá's «Tu compra por 94,208 fue aprobada con Tarjeta Crédito 4505 el 06/11/26 18:36:05 en FARMATODO
// PRADOS DEL E ¿Dudas? Llama…»: the business, up to the bank's help question.
const approvedPurchase: Shape = (text) => {
  const match = /\btu\s+compra\b.*?\sfue\s+aprobada\b.*?\sen\s+(.+?)(?=\s*[¿?]|\s+dudas\b|\s*$)/iu.exec(text);
  return match ? readableName(match[1]) : null;
};

// «pagaste $39,000.00 por codigo QR … a la llave @drogueriamia»: the handle; a numeric key has only its tail.
const keyPayment: Shape = (text) => {
  const match = /\bpagaste\b.*?\ba\s+la\s+llave\s+@?([\w.-]+)/iu.exec(text);
  if (!match) return null;

  return /^\d{4,}$/.test(match[1]) ? `Pago a *${lastFour(match[1])}` : match[1];
};

const PAID_TO = new RegExp(String.raw`\bpagaste\s+${AMOUNT}\s*a\s+(?!la\s+(?:llave|cuenta)\b)(.+?)${NAME_END}`, "iu");

// «Pagaste $1,000,000.00 a FONDO NACIONAL DEL AHORRO desde tu producto 3397»: whoever was paid.
const payment: Shape = (text) => {
  const match = PAID_TO.exec(text);
  return match ? readableName(match[1]) : null;
};

// «Transferiste $10,000.00 a la llave 1090480304 … a LUIS ALBERTO TORRES GARCIA» names the person; «… a la cuenta
// *3118882698» only the tail of the account.
const transfer: Shape = (text) => {
  const sent = /\btransferiste\b/iu.exec(text);
  if (!sent) return null;

  const rest = text.slice(sent.index);
  const person = new RegExp(String.raw`\sa\s+${PERSON}`, "u").exec(rest);
  if (person) return readableName(person[1]);

  const number = extractNumber(rest);
  return number === null ? null : `Transferencia a *${lastFour(number)}`;
};

// «recibiste una transferencia de JULIAN … por $450,000.00» and «… por $340,000 de CARLOS NIETO»: who sent it.
const incomingTransfer: Shape = (text) => {
  const received = /\brecibiste\s+una\s+transferencia\b/iu.exec(text);
  if (!received) return null;

  const sender = new RegExp(String.raw`\bde\s+${PERSON}`, "u").exec(text.slice(received.index));
  return sender ? `De ${readableName(sender[1])}` : null;
};

// «Recibiste una consignacion por $500,000 desde el corresponsal BARRIO … en CUCUTA».
const deposit: Shape = (text) => {
  if (!/\brecibiste\s+una\s+consignaci[oó]n\b/iu.test(text)) return null;
  return /\bcorresponsal\b/iu.test(text) ? "Consignación corresponsal" : "Consignación";
};

// Specific before general: a QR payment names a key, a plain payment a business.
const SHAPES: Shape[] = [
  withdrawal,
  keyPayment,
  purchase,
  purchaseNoun,
  approvedPurchase,
  paidAt,
  payment,
  incomingTransfer,
  deposit,
  transfer,
];

/** The short description a bank alert's words give, whatever boilerplate surrounds them; null when none of its shapes fits. */
export function describeAlert(text: string): string | null {
  const flat = flatten(text);
  for (const shape of SHAPES) {
    const description = shape(flat);
    if (description) return description;
  }
  return null;
}

// What a description reads like once the amount was cut out of the sentence it was taken from: «por $ en», a
// lead of «: » or a sender label cut to «Da : ».
const DAMAGED = /\$(?!\s?\d)|^\s*[:;,.]|\b\p{L}{1,3}\s:\s/u;

/**
 * The description of a message as a person would write it: what its own words say when a shape fits, else the
 * stored one, else, when that one is a sentence with its figure cut out, the business the message names. Runs
 * when a delivery is read as well as when it is written, so rows stored damaged read right (RF-279).
 */
export function repairDescription(stored: string | null, rawText: string, merchantLabel: string | null): string | null {
  const described = describeAlert(rawText);
  if (described) return withoutClock(described);
  if (stored === null || !DAMAGED.test(stored) || merchantLabel === null) return stored === null ? null : withoutClock(stored);

  const business = readableName(merchantLabel.replace(/\s+\d{1,2}:\d{2}\b.*$/u, ""));
  return business === "" ? withoutClock(stored) : business;
}

/** A description without the time of day a bank prints after the business («RAPPI* 15:32» → «RAPPI»). */
export function withoutClock(description: string): string {
  const cut = description.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?\s*$/iu, "").replace(/[\s*]+$/u, "");
  return cut === "" ? description : cut;
}

// The sender labels a bank's alert opens with.
const SENDER_LABEL = /\b(?:Bancolombia|Nequi|Davivienda|Lulo|Nu|Banco de Bogot[aá])\s*:/u;
// The verb that opens a bank's sentence about the person's money.
const BANK_VERB = /\b(?:compraste|pagaste|transferiste|recibiste|retiraste|tu compra)\b/iu;

/** Whether the text reads as a bank's alert, so its remainder may be cleaned as one. */
export function looksLikeBankAlert(text: string): boolean {
  return SENDER_LABEL.test(text) && BANK_VERB.test(text);
}

// The «only account» fallback: a bank's alert that names no tail belongs to the person's one bank
// account at that institution.
export type AccountOption = { id: string; name: string; institution: string | null; subtype: string };

/**
 * The person's one bank account (not a card) whose name or institution is the bank the alert names;
 * null when none, or more than one, matches: guessing between two is worse than asking.
 */
export function onlyBankAccount(text: string, accounts: readonly AccountOption[]): string | null {
  if (!/\bbancolombia\b/iu.test(text)) return null;

  const found = accounts.filter(
    (account) => account.subtype === "bank" && /bancolombia/iu.test(`${account.name} ${account.institution ?? ""}`),
  );
  return found.length === 1 ? found[0].id : null;
}

// A bank's words for a credit card: «T.Cred *1234», «tarjeta crédito 1234», «tarjeta de crédito».
const CREDIT_CARD_WORDS = /\b(?:t\.?\s?cred|tarjeta\s+(?:de\s+)?cr[eé]dito)/iu;

/** Whether the message words a credit-card purchase. */
export function namesCreditCard(text: string): boolean {
  return CREDIT_CARD_WORDS.test(text);
}

export type CardPurchaseOption = { id: string; subtype: string; lastFour?: string | null };

/**
 * Whether the text is a bank's card purchase, and the card it names. Only a card whose last four match the
 * ending the message gives is proposed; with none, or the ending unknown, the person picks. A loan or any other
 * debt is never proposed: a card's word («Cred») also starts the name «Crédito carro».
 */
export function cardPurchase(
  text: string,
  tails: ReadonlySet<string>,
  accounts: readonly CardPurchaseOption[],
  defaultAccountId: string | null,
): { isCard: false } | { isCard: true; accountId: string | null } {
  if (!CREDIT_CARD_WORDS.test(text)) return { isCard: false };

  const cards = accounts.filter((account) => account.subtype === "card");
  if (tails.size === 0) {
    return { isCard: true, accountId: cards.find((card) => card.id === defaultAccountId)?.id ?? null };
  }

  const named = cards.filter((card) => card.lastFour && tails.has(card.lastFour));
  return { isCard: true, accountId: named.length === 1 ? named[0].id : null };
}

// The payee a payment names: «Pagaste $X a NU Compañía de Financiamiento desde…», or a receipt's «Empresa: …».
function payeeOf(text: string): string | null {
  return PAID_TO.exec(flatten(text))?.[1] ?? emailMerchant(flatten(text));
}

export type CardOption = { id: string; institution: string | null; subtype: string };

function folded(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The person's own card or loan that a payment pays: the payee names the institution of exactly one of
 * them («NU Compañía de Financiamiento» → the Nu card), so the payment is a transfer, not an expense.
 * Several cards of one institution, or none, leave the destination to the person.
 */
export function paidOwnCard(text: string, accounts: readonly CardOption[]): string | null {
  const payee = payeeOf(text);
  if (payee === null) return null;

  const name = folded(payee);
  const found = accounts.filter((account) => {
    const institution = account.institution === null ? "" : folded(account.institution).trim();
    if (institution === "" || (account.subtype !== "card" && account.subtype !== "loan")) return false;
    return new RegExp(String.raw`(?<![a-z0-9])${institution.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(name);
  });
  return found.length === 1 ? found[0].id : null;
}
