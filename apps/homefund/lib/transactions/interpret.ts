import { addCivilDays, isCivilDate } from "@/lib/dates";
import { normalizeGroupMarks, parseAmount } from "@/lib/money";
import {
  categoryFromMemory,
  categoryFromMerchant,
  type PhraseMemory,
} from "@/lib/transactions/merchant-category";

// Quick entry reads one text field and proposes an editable movement (RF-22).
// Everything it returns is a proposal the form may overwrite; a field is null
// when nothing matched. It is pure: no DB, no async, no side effect.

// The first run of digits, optionally carrying the thousands separators a
// person types by hand; `normalizeGroupMarks` strips those to a peso string.
const AMOUNT_PATTERN = /\d[\d.,]*\d|\d/g;
// A spoken multiplier right after the amount (RF-22): «mil» and «k» are a
// thousand, «M», «millón» and «millones» a million. A letter or digit after the
// token makes it part of a word: «3 milanesas», «4 kg», «4 m2».
const MULTIPLIER_PATTERN =
  /^\s*(millones|mill[oó]n|mil|k|m)(?![\p{L}\p{N}_])/iu;
// The one letter whose case decides: an uppercase «M» glued or as the last word
// is a million; a lowercase «m» is never read as a figure and always asks.
const MILLION_LETTER = "M";
const LOWER_MILLION_LETTER = "m";
const THOUSAND_ZEROS = 3;
// «mil» standing as its own word with no digits before it: «pagué mil» is a
// thousand pesos, never a million.
const BARE_THOUSAND_PATTERN = /(?<![\p{L}\p{N}_])mil(?![\p{L}\p{N}_])/iu;
const BARE_THOUSAND_PESOS = "1000";
// «millón» or «un millón» with no digits before it: a million pesos, as «mil»
// alone is a thousand. «millonario» is a word of its own.
const BARE_MILLION_PATTERN =
  /(?<![\p{L}\p{N}_])(?:un\s+)?mill[oó]n(?![\p{L}\p{N}_])/iu;
const BARE_MILLION_PESOS = "1000000";
const MULTIPLIER_ZEROS: Record<string, number> = { mil: 3, k: 3 };
const MILLION_ZEROS = 6;
// What may stand before a multiplier: whole digits, or up to two decimals.
// «1.500 mil» could be 1 500 000 or 1 500; neither is guessed.
const MANTISSA_PATTERN = /^(\d+)(?:[.,](\d{1,2}))?$/;
// What says the money came in: a bank's «recibiste», a payroll, «te enviaron», a wallet's «tu plata de X ya está en…».
// A question («¿Recibiste un correo sospechoso?») says nothing.
const INCOME_PATTERN =
  /(?<!¿)\brecibiste\b(?!\s+un\s+(?:correo|mensaje|llamada))|\bn[oó]mina\b|\bte\s+(?:enviaron|transfirieron|consignaron)\b|\btu\s+plata\s+de\s+\p{L}+\s+ya\s+est|\bse\s+le\s+acaba\s+de\s+pagar\b|\bmonto\s+recibido\b/iu;
// What says the money went out, in a bank's alert, a wallet's receipt or a gateway's approval.
const EXPENSE_PATTERN =
  /\b(?:transferiste|compraste|pagaste|retiraste|hiciste\s+un\s+pago|realizaste\s+(?:una\s+transferencia|un\s+pago|un\s+env[ií]o|un\s+retiro)|env[ií]o\s+con\s+bre-?b\s+exitoso|pago\s+(?:exitoso|hecho)|transacci[oó]n\s+#?\d*\s*(?:aprobada|aceptada)|compra\s+por\s+\$|gracias\s+por\s+tu\s+compra|tu\s+recibo|comprobante\s+de\s+pago|total\s+pagado)\b|\btu\s+compra\b[\s\S]*\bfue\s+aprobada\b/iu;
// The person's own account or card in a bank's words: «*1234», «**1234», «producto 1234»,
// «T.Cred *1234», «tarjeta crédito 1234», «AMEX •••• 1234».
const OWN_TAIL_PATTERNS = [
  /\*+\s*(\d{4})\b/gu,
  /\btarjeta\s+cr[eé]dito\s+(\d{4})\b/giu,
  /\b(?:producto|cuenta|tarjeta|t\.?\s?(?:deb|cred))\s+(\d{4})\b/giu,
  /[•·]{2,}\s*(\d{4})\b/gu,
];
// Where the money left from and where it landed, as a wallet's receipt labels them: «Origen cuenta • 1234».
const ORIGIN_TAIL = /\borigen\s+(?:cuenta|ahorro|producto|tarjeta)?\s*[•·*:\s]*(\d{4})\b/giu;
const DESTINATION_TAIL = /\bdestino\s+(?:cuenta|ahorro|producto|tarjeta)?\s*[•·*:\s]*(\d{4})\b/giu;
// «a la cuenta *1234» and «de la cuenta *1234» name somebody else's account.
const OTHER_PARTY_BEFORE = /\b(?:a|de)\s+(?:la\s+)?(?:cuenta|llave|tarjeta)\s*$/iu;
// Colombian banks write the day first: `el 24/08/26 a las 18:31` and
// `el 25/08/2026 a las 20:07` both name a day in August.
const DATE_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/u;
// A typed phrase may leave the year out («15/11») and name the day in words or as an ISO date (RF-273).
const SHORT_DATE_PATTERN = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/u;
const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const DAY_WORDS: [RegExp, number][] = [
  [/(?<![\p{L}\p{N}_])anteayer(?![\p{L}\p{N}_])/iu, -2],
  [/(?<![\p{L}\p{N}_])ayer(?![\p{L}\p{N}_])/iu, -1],
  [/(?<![\p{L}\p{N}_])hoy(?![\p{L}\p{N}_])/iu, 0],
];
// «a 12 cuotas», «en 6 cuotas», «12 cuotas»: how many instalments a card purchase is split into (RF-273).
const INSTALMENTS_PATTERN = /(?<![\p{L}\p{N}_])(?:(?:a|en)\s+)?(\d{1,2})\s+cuotas?(?![\p{L}\p{N}_])/iu;
// A currency said in words beside the figure: «15,99 dólares», «usd 9», «US$15», «20 euros». «US$» sits
// against its figure, so only the letters-and-word forms need a boundary after them.
const CURRENCY_WORD =
  /(?<![\p{L}\p{N}_])(?:us\$|(?:d[oó]lar(?:es)?|usd|euros?|eur)(?![\p{L}\p{N}_])|€)/iu;
const CURRENCY_OF_WORD: [RegExp, string][] = [
  [/^(?:us\$|d[oó]lar|usd)/iu, "USD"],
  [/^(?:euro|eur|€)/iu, "EUR"],
];
// What a typed phrase says about the day, with the «el» that may lead a date.
const DATE_WORDS_IN_TEXT = [
  /(?<![\p{L}\p{N}_])(?:el\s+)?\d{4}-\d{2}-\d{2}(?![\d])/giu,
  /(?<![\p{L}\p{N}_])(?:el\s+)?\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})(?![\d/])/giu,
  /(?<![\p{L}\p{N}_])(?:el\s+)?(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/giu,
  /(?<![\p{L}\p{N}_])(?:anteayer|ayer|hoy)(?![\p{L}\p{N}_])/giu,
];

// Thousands written with dots and then a second dot before one or two digits: «12.000.50» is either
// «12.000,50» or «1.200.050», and a guess would move real money.
const MARKS_AMBIGUOUS = /^\d{1,3}(?:\.\d{3})+\.\d{1,2}$/;

interface InterpretContext {
  categories: { id: string; name: string; kind: string }[];
  accounts: { id: string; name: string; lastFour?: string | null }[];
  defaultAccountId: string | null;
  // A bank's message dates itself («15 Octubre 2026»). «dated»: a year-like run beside a month or «de»
  // is no amount. «any»: a year-like run with no currency mark is none either (a bank email's
  // «caso 2026»). Typed quick entry leaves it off, so «2000 de bus» keeps its amount.
  yearGuard?: "dated" | "any";
  // Today, as `YYYY-MM-DD`: only with it does a phrase read «hoy», «ayer» and a day without its year (RF-273).
  today?: string;
  // What the person typed before and where it went, newest first: tried before the common spends.
  memory?: readonly PhraseMemory[];
}

// A spaced «M» with words after it («3 M arriendo») is not guessed: the person
// picks the bare number or the number times a million. A lowercase «m» is never
// guessed: the person picks the bare number, thousands or millions. Choices are
// stored cents, and only whole pesos are offered.
export interface AmountAsk {
  token: string;
  // `fromWords` is false only for the digits as written (RF-155).
  choices: { cents: number; fromWords: boolean }[];
  // Set when the question is the marks of a figure («12.000.50») and not a spoken multiplier (RF-274).
  marks?: true;
}

interface QuickEntryProposal {
  amountPesos: string | null;
  // The amount came from words («25 mil», «un millón»), not from digits alone (RF-155).
  amountFromWords: boolean;
  ask: AmountAsk | null;
  categoryId: string | null;
  description: string;
  // A typed phrase without the figure, currency, day and instalments read from it; the category and account words stay.
  phrase: string;
  accountId: string | null;
  direction: "income" | "expense" | null;
  occurredAt: string | null;
  // The instalments a phrase asks («a 12 cuotas»), never read from a bank's message (RF-273).
  instalments: number | null;
  // The currency a typed phrase names in words («dólares», «usd», «euros»); null when it names none.
  currency: "USD" | "EUR" | null;
}

// The day the message names, as `YYYY-MM-DD`; null when it names none or names
// a day no month holds. Whether that day is in the future needs a clock (RF-98).
// With `today`, a phrase may also say «hoy», «ayer», «anteayer» or give a day and month alone, which
// takes the latest year that is not in the future (RF-273).
function readOccurredAt(text: string, today?: string): string | null {
  const iso = ISO_DATE_PATTERN.exec(text);
  if (iso && isCivilDate(iso[0])) return iso[0];

  const match = DATE_PATTERN.exec(text);
  if (match) {
    const [, day, month, year] = match;
    const civil = `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

    return isCivilDate(civil) ? civil : null;
  }
  if (!today) return null;

  const short = SHORT_DATE_PATTERN.exec(text);
  if (short) {
    const [, day, month] = short;
    const stamp = (year: number) =>
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const year = Number(today.slice(0, 4));
    for (const candidate of [stamp(year), stamp(year - 1)]) {
      if (isCivilDate(candidate) && candidate <= today) return candidate;
    }
  }

  const word = DAY_WORDS.find(([pattern]) => pattern.test(text));
  return word ? addCivilDays(today, word[1]) : null;
}

// The mantissa shifted by the multiplier's zeros, as whole pesos: the digits are
// concatenated, never multiplied, so «2,01k» is 2010 and not 2009.99….
function multiplyPesos(mantissa: string, zeros: number): string | null {
  const parts = MANTISSA_PATTERN.exec(mantissa);
  if (!parts) return null;
  const [, whole, fraction = ""] = parts;
  const digits = `${whole}${fraction.padEnd(zeros, "0")}`;
  return digits.replace(/^0+(?=\d)/, "");
}

// The bare number, thousands and millions of a lowercase «m», each as stored
// cents. A choice that is not whole pesos («1,15» bare) is left out: the sheet
// never offers a figure with cents the person did not write as such, and then
// every choice left is read from words.
function lowerMChoices(amount: string): AmountAsk["choices"] {
  const mantissa = MANTISSA_PATTERN.test(amount)
    ? amount
    : normalizeGroupMarks(amount);
  const pesos = [
    normalizeGroupMarks(amount),
    multiplyPesos(mantissa, THOUSAND_ZEROS) ?? `${mantissa}000`,
    multiplyPesos(mantissa, MILLION_ZEROS) ?? `${mantissa}000000`,
  ];
  const [written, ...multiplied] = pesos.map((value) => parseAmount(value));
  const offered = (cents: number | null): cents is number =>
    cents !== null && cents > 0 && cents % 100 === 0;
  return [
    ...(offered(written) ? [{ cents: written, fromWords: false }] : []),
    ...multiplied.filter(offered).map((cents) => ({ cents, fromWords: true })),
  ];
}

// Words right before a run that say it is no amount: a reference, an order, an
// account or a phone. A «factura» only counts when the run is as long as an invoice
// number, so «Factura 45000» keeps its amount.
const NOT_AMOUNT_BEFORE =
  /(?:\b(?:ref|referencia|pedido|no|nro|n[uú]mero|cuenta|tel|tel[eé]fono|cel|celular|nit)\.?|#)\s*:?\s*$/iu;
const INVOICE_BEFORE = /\bfactura\s*:?\s*$/iu;
// Words right before a run that say it is the amount.
const AMOUNT_BEFORE = /(?:\b(?:valor|monto|por|total|pago de|pagu[eé]|pagaste)\s*(?:de\s*)?:?)\s*$/iu;

// A mobile line (10 digits starting with 3) or a toll-free one (01800…).
function phoneLike(run: string): boolean {
  const digits = run.replace(/\D/g, "");
  return (digits.length === 10 && digits.startsWith("3")) || digits.startsWith("01800");
}

// The instalments a phrase names, only inside the range a deferral accepts.
function readInstalments(text: string): number | null {
  const match = INSTALMENTS_PATTERN.exec(text);
  if (!match) return null;
  const count = Number(match[1]);
  return count >= 2 && count <= 72 ? count : null;
}

// The two readings of «12.000.50»: the dot before the last digits as a decimal mark, or every dot as a
// thousands group. Each as stored cents; null when either does not read as one.
function marksChoices(written: string): AmountAsk["choices"] | null {
  const lastDot = written.lastIndexOf(".");
  const decimal = parseAmount(`${written.slice(0, lastDot).replaceAll(".", "")},${written.slice(lastDot + 1)}`);
  const thousands = parseAmount(written.replaceAll(".", ""));
  if (decimal === null || thousands === null) return null;
  return [
    { cents: decimal, fromWords: false },
    { cents: thousands, fromWords: false },
  ];
}

// The standalone number that is the amount: a run glued to a letter («D1», «m2»)
// or part of a date or a clock («24/08/26», «18:31») or a card mask is left in
// the note. A run the text marks as money wins; then one the text says is a
// reference, an account or a phone is set aside, and of the rest the one beside
// an amount word («valor», «total», «por»), else the first that is no bare
// quantity («Mercado 2 87500» reads 87500).
const MONTH_WORD =
  "(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)";
const MONTH_OR_DE_BEFORE = new RegExp(`(?:\\b${MONTH_WORD}\\.?|\\bde)\\s+$`, "iu");
const MONTH_OR_DE_AFTER = new RegExp(`^\\s+(?:${MONTH_WORD}\\b|de\\b)`, "iu");

// A year (19xx, 20xx): beside a month name or «de», or under the «any» guard wherever it stands.
function yearLike(text: string, match: RegExpMatchArray, guard: "dated" | "any"): boolean {
  const at = match.index ?? 0;
  if (!/^(?:19|20)\d{2}$/.test(match[0])) return false;
  return (
    guard === "any" ||
    MONTH_OR_DE_BEFORE.test(text.slice(0, at)) ||
    MONTH_OR_DE_AFTER.test(text.slice(at + match[0].length))
  );
}

// An ISO code right before the figure («COP122.000,50», «USD 9,99»). Only the codes a bank prints for pesos or
// the foreign purchases it converts: any three capitals would read a reference («DCB5FA06») as an amount.
const CURRENCY_MARK = /(?<![\p{L}\d])(?:COP|USD|EUR|GBP|MXN|CAD|BRL|ARS|CLP|PEN)$/u;

function findAmountToken(text: string, yearGuard?: "dated" | "any"): RegExpExecArray | null {
  // A currency mark right before the run («$», «COP122.000,50») says it is money
  // whatever else the text holds; the letters glue it to a word only otherwise.
  const markedBefore = (match: RegExpMatchArray): boolean => {
    const head = text.slice(0, match.index);
    return /\$\s*$/.test(head) || CURRENCY_MARK.test(head);
  };
  const candidates = [...text.matchAll(AMOUNT_PATTERN)].filter((match) => {
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + match[0].length] ?? "";
    return (
      (!/[\p{L}_/:*]/u.test(before) || markedBefore(match)) &&
      !/[/:]/u.test(after) &&
      !(yearGuard && !markedBefore(match) && yearLike(text, match, yearGuard))
    );
  });
  const marked = candidates.find(markedBefore);
  if (marked) return marked as RegExpExecArray;

  const kept = candidates.filter((match) => {
    const head = text.slice(0, match.index);
    if (phoneLike(match[0])) return false;
    if (NOT_AMOUNT_BEFORE.test(head)) return false;
    return !(INVOICE_BEFORE.test(head) && match[0].replace(/\D/g, "").length >= 7);
  });
  const pool = kept.length > 0 ? kept : candidates;

  const named = pool.find((match) => AMOUNT_BEFORE.test(text.slice(0, match.index)));
  if (named) return named as RegExpExecArray;

  const quantity = (match: RegExpMatchArray) => match[0].replace(/\D/g, "").length <= 2;
  const first = pool.find((match) => !quantity(match)) ?? pool[0] ?? null;
  return first as RegExpExecArray | null;
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

const MIN_PREFIX_LENGTH = 4;

// The words of the text that begin a word of the name, ignoring case and
// accents: «bancolombia» names the account «Bancolombia ahorros». Only words of
// four letters or more count, so «de» or «la» never name anything.
function prefixWord(text: string, name: string): string | null {
  const nameWords = fold(name).split(/[^\p{L}\p{N}]+/u);
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    words.find(
      (word) =>
        word.length >= MIN_PREFIX_LENGTH &&
        !/\d/u.test(word) &&
        nameWords.some((nameWord) => nameWord.startsWith(fold(word))),
    ) ?? null
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The first verb says which way the money went: «recibiste» before «pagaste» is an income.
function readDirection(text: string): "income" | "expense" | null {
  const income = INCOME_PATTERN.exec(text)?.index ?? Infinity;
  const expense = EXPENSE_PATTERN.exec(text)?.index ?? Infinity;
  if (income === Infinity && expense === Infinity) return null;

  return income < expense ? "income" : "expense";
}

// The last four digits the message gives for the person's own account. The side a wallet labels
// «origen» is the person's only when the money went out, «destino» only when it came in.
export function readAccountTails(text: string, direction: "income" | "expense" | null): Set<string> {
  const own = OWN_TAIL_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)]
      .filter((match) => !OTHER_PARTY_BEFORE.test(text.slice(0, match.index)))
      .map((match) => match[1]),
  );
  const labeled =
    direction === null
      ? []
      : [...text.matchAll(direction === "expense" ? ORIGIN_TAIL : DESTINATION_TAIL)].map((match) => match[1]);

  return new Set([...own, ...labeled]);
}

export function interpretQuickEntry(
  text: string,
  ctx: InterpretContext,
): QuickEntryProposal {
  const lower = text.toLowerCase();
  // The words that name a day or a number of instalments hold digits that are no amount; they are blanked,
  // same length, so every index below still points into `text`.
  const instalments = readInstalments(text);
  const scan = text
    .replace(INSTALMENTS_PATTERN, (found) => " ".repeat(found.length))
    .replace(ISO_DATE_PATTERN, (found) => " ".repeat(found.length));

  // The earliest of a digit run, a bare «mil» and a bare «millón» is the amount.
  const amountMatch =
    [
      findAmountToken(scan, ctx.yearGuard),
      BARE_THOUSAND_PATTERN.exec(scan),
      BARE_MILLION_PATTERN.exec(scan),
    ]
      .filter((match) => match !== null)
      .sort((a, b) => a.index - b.index)[0] ?? null;
  const bareWord = amountMatch && !/\d/u.test(amountMatch[0]) ? amountMatch[0] : null;
  const amountEnd = amountMatch ? amountMatch.index + amountMatch[0].length : 0;
  const afterAmount = text.slice(amountEnd);
  const tokenMatch =
    amountMatch && bareWord === null ? MULTIPLIER_PATTERN.exec(afterAmount) : null;
  const letter = tokenMatch?.[1];
  const tokenText = tokenMatch?.[0] ?? "";
  const isLowerAsk = letter === LOWER_MILLION_LETTER;
  const isAsk =
    isLowerAsk ||
    (letter === MILLION_LETTER &&
      /^\s/u.test(tokenText) &&
      afterAmount.slice(tokenText.length).trim().length > 0);
  const multiplierMatch = isAsk ? null : tokenMatch;

  let ask: AmountAsk | null = null;
  if (isLowerAsk && amountMatch) {
    const choices = lowerMChoices(amountMatch[0]);
    if (choices.length > 1) {
      ask = {
        token: text.slice(amountMatch.index, amountEnd + tokenText.length),
        choices,
      };
    }
  } else if (isAsk && amountMatch) {
    const bare = parseAmount(amountMatch[0]);
    const millionPesos = multiplyPesos(amountMatch[0], MILLION_ZEROS);
    const million = millionPesos === null ? null : parseAmount(millionPesos);
    if (bare !== null && million !== null) {
      ask = {
        token: text.slice(amountMatch.index, amountEnd + tokenText.length),
        choices: [
          { cents: bare, fromWords: false },
          { cents: million, fromWords: true },
        ],
      };
    }
  }

  // «12.000.50» asks which of its two readings is meant (RF-274), with no amount proposed meanwhile.
  const marksAsk =
    ask === null && !isAsk && amountMatch && !multiplierMatch && MARKS_AMBIGUOUS.test(amountMatch[0])
      ? marksChoices(amountMatch[0])
      : null;
  if (marksAsk) {
    ask = { token: amountMatch![0], choices: marksAsk, marks: true };
  }

  const amountPesos = !amountMatch || isAsk || marksAsk
    ? null
    : bareWord !== null
      ? BARE_MILLION_PATTERN.test(bareWord)
        ? BARE_MILLION_PESOS
        : BARE_THOUSAND_PESOS
      : multiplierMatch
        ? multiplyPesos(
            amountMatch[0],
            MULTIPLIER_ZEROS[multiplierMatch[1].toLowerCase()] ?? MILLION_ZEROS,
          )
        : normalizeGroupMarks(amountMatch[0]);
  const direction = readDirection(text);
  const mentionedTails = readAccountTails(text, direction);
  const matchedAccounts = ctx.accounts.filter(
    (account) => account.lastFour && mentionedTails.has(account.lastFour),
  );
  const namedAccounts = ctx.accounts.filter(
    (account) => prefixWord(text, account.name) !== null,
  );
  const matchedAccountId =
    matchedAccounts.length === 1
      ? matchedAccounts[0].id
      : matchedAccounts.length === 0 && namedAccounts.length === 1
        ? namedAccounts[0].id
        : null;
  // The word leaves the description only when it named the account actually chosen:
  // a last-four mention can pick one account while another's name is also in the text.
  const namedAccountWord =
    matchedAccountId && namedAccounts.length === 1 && namedAccounts[0].id === matchedAccountId
      ? prefixWord(text, namedAccounts[0].name)
      : null;

  // The first category whose name reads in the text as whole words, so «vivienda» is never found inside
  // «Davivienda»; the token it matched drops out of the description below.
  const substringCategory =
    ctx.categories.find((category) => {
      const name = category.name.trim().toLowerCase();
      return name.length > 0 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u").test(lower);
    }) ?? null;
  // Failing that, the one category a word of the text begins a word of.
  const namedCategories = substringCategory
    ? []
    : ctx.categories.filter(
        (category) => prefixWord(text, category.name) !== null,
      );
  // Then what the person did before (RF-273), then a category one of whose words starts a word of the text, and
  // last what everyone calls a common spend: none of them needs the category's whole name in the text.
  const rememberedId =
    substringCategory || !ctx.memory
      ? null
      : categoryFromMemory(text, ctx.memory, ctx.categories);
  const remembered = rememberedId
    ? (ctx.categories.find((category) => category.id === rememberedId) ?? null)
    : null;
  const merchantId =
    substringCategory || remembered || namedCategories.length === 1
      ? null
      : categoryFromMerchant(text, ctx.categories);
  const merchant = merchantId
    ? (ctx.categories.find((category) => category.id === merchantId) ?? null)
    : null;
  const matchedCategory =
    substringCategory ??
    remembered ??
    (namedCategories.length === 1 ? namedCategories[0] : null) ??
    merchant;
  const namedCategoryWord =
    !substringCategory && !remembered && !merchant && matchedCategory
      ? prefixWord(text, matchedCategory.name)
      : null;

  // What is left once the amount, its multiplier and any matched category
  // token are removed.
  let description = text;
  if (amountMatch) {
    // An asked «m» or «M» leaves with its number: the description reads «arriendo».
    const cutEnd =
      amountEnd + ((isAsk ? tokenMatch : multiplierMatch)?.[0].length ?? 0);
    description = `${text.slice(0, amountMatch.index)} ${text.slice(cutEnd)}`;
  }
  // The words as typed, minus the figures read from them: the category and account words stay.
  let phrase = description;
  if (matchedCategory && !remembered && !merchant) {
    const token = namedCategoryWord ?? matchedCategory.name.trim();
    description = description.replace(new RegExp(escapeRegExp(token), "i"), " ");
  }
  if (namedAccountWord) {
    description = description.replace(
      new RegExp(escapeRegExp(namedAccountWord), "i"),
      " ",
    );
  }
  // A typed phrase keeps only the words it did not use as a figure: the currency, the day and the
  // instalments it read leave the description too. A bank's message keeps its text.
  const typed = ctx.today !== undefined;
  const currencyWord = typed ? CURRENCY_WORD.exec(text)?.[0] : undefined;
  const currency = currencyWord
    ? ((CURRENCY_OF_WORD.find(([pattern]) => pattern.test(currencyWord))?.[1] ?? null) as "USD" | "EUR" | null)
    : null;
  const dropReadWords = (value: string): string => {
    if (!typed) return value;
    let kept = value.replace(new RegExp(CURRENCY_WORD.source, "giu"), " ");
    if (amountMatch) kept = kept.replace(/\$\s*(?=\s|$)/u, " ");
    kept = kept.replace(INSTALMENTS_PATTERN, " ");
    if (readOccurredAt(text, ctx.today) !== null) {
      for (const pattern of DATE_WORDS_IN_TEXT) kept = kept.replace(pattern, " ");
    }
    return kept;
  };
  description = dropReadWords(description);
  phrase = dropReadWords(phrase).replace(/\s+/g, " ").trim();
  description = description.replace(/\s+/g, " ").trim();

  return {
    amountPesos,
    amountFromWords: amountPesos !== null && (bareWord !== null || multiplierMatch !== null),
    ask,
    categoryId: matchedCategory?.id ?? null,
    description,
    phrase,
    // A uniquely named bank tail outranks the last-used fallback (RF-97, RF-22).
    accountId: matchedAccountId ?? ctx.defaultAccountId,
    direction,
    occurredAt: readOccurredAt(text, ctx.today),
    instalments,
    currency,
  };
}
