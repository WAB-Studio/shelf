import { isCivilDate } from "@/lib/dates";
import { normalizeAmountInput, parseAmount } from "@/lib/money";

// Quick entry reads one text field and proposes an editable movement (RF-22).
// Everything it returns is a proposal the form may overwrite; a field is null
// when nothing matched. It is pure: no DB, no async, no side effect.

// The first run of digits, optionally carrying the thousands separators a
// person types by hand; `normalizeAmountInput` strips those to a peso string.
const AMOUNT_PATTERN = /\d[\d.,]*\d|\d/;
// A spoken multiplier right after the amount (RF-22): «mil» and «k» are a
// thousand, «M», «millón» and «millones» a million. A letter or digit after the
// token makes it part of a word: «3 milanesas», «4 kg», «4 m2».
const MULTIPLIER_PATTERN =
  /^\s*(millones|mill[oó]n|mil|k|m)(?![\p{L}\p{N}_])/iu;
// The one letter whose case decides: a lowercase «m» is never a million
// («25 m», «5 m de cable»), an uppercase «M» glued or as the last word is.
const MILLION_LETTER = "M";
const LOWER_MILLION_LETTER = "m";
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
const INCOME_PATTERN = /\brecibiste\s+una\s+transferencia\b/iu;
const EXPENSE_PATTERN =
  /\b(?:transferiste|compraste|pagaste)\b|\btu\s+compra\b[\s\S]*\bfue\s+aprobada\b/iu;
const ACCOUNT_TAIL_PATTERNS = [
  /\*+\s*(\d{4})\b/gu,
  /\btarjeta\s+cr[eé]dito\s+(\d{4})\b/giu,
];
// Colombian banks write the day first: `el 24/08/26 a las 18:31` and
// `el 25/08/2026 a las 20:07` both name a day in August.
const DATE_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/u;

interface InterpretContext {
  categories: { id: string; name: string; kind: string }[];
  accounts: { id: string; name: string; lastFour?: string | null }[];
  defaultAccountId: string | null;
}

// A spaced «M» with words after it («3 M arriendo») is not guessed: the person
// picks the bare number or the number times a million, both in stored cents.
export interface AmountAsk {
  token: string;
  choices: [number, number];
}

interface QuickEntryProposal {
  amountPesos: string | null;
  ask: AmountAsk | null;
  categoryId: string | null;
  description: string;
  accountId: string | null;
  direction: "income" | "expense" | null;
  occurredAt: string | null;
}

// The day the message names, as `YYYY-MM-DD`; null when it names none or names
// a day no month holds. Whether that day is in the future needs a clock (RF-98).
function readOccurredAt(text: string): string | null {
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;

  const [, day, month, year] = match;
  const civil = `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

  return isCivilDate(civil) ? civil : null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function interpretQuickEntry(
  text: string,
  ctx: InterpretContext,
): QuickEntryProposal {
  const lower = text.toLowerCase();

  // The earliest of a digit run, a bare «mil» and a bare «millón» is the amount.
  const amountMatch =
    [
      AMOUNT_PATTERN.exec(text),
      BARE_THOUSAND_PATTERN.exec(text),
      BARE_MILLION_PATTERN.exec(text),
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
  const isAsk =
    letter === MILLION_LETTER &&
    /^\s/u.test(tokenText) &&
    afterAmount.slice(tokenText.length).trim().length > 0;
  const multiplierMatch =
    letter === LOWER_MILLION_LETTER || isAsk ? null : tokenMatch;

  let ask: AmountAsk | null = null;
  if (isAsk && amountMatch) {
    const bare = parseAmount(amountMatch[0]);
    const millionPesos = multiplyPesos(amountMatch[0], MILLION_ZEROS);
    const million = millionPesos === null ? null : parseAmount(millionPesos);
    if (bare !== null && million !== null) {
      ask = {
        token: text.slice(amountMatch.index, amountEnd + tokenText.length),
        choices: [bare, million],
      };
    }
  }

  const amountPesos = !amountMatch || isAsk
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
        : normalizeAmountInput(amountMatch[0]);
  const mentionedTails = new Set(
    ACCOUNT_TAIL_PATTERNS.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => match[1]),
    ),
  );
  const matchedAccounts = ctx.accounts.filter(
    (account) => account.lastFour && mentionedTails.has(account.lastFour),
  );
  const matchedAccountId =
    matchedAccounts.length === 1 ? matchedAccounts[0].id : null;

  // The first category whose name reads as a substring of the text; the token
  // it matched drops out of the description below.
  const matchedCategory =
    ctx.categories.find((category) => {
      const name = category.name.trim().toLowerCase();
      return name.length > 0 && lower.includes(name);
    }) ?? null;

  // What is left once the amount, its multiplier and any matched category
  // token are removed.
  let description = text;
  if (amountMatch) {
    // An asked «M» leaves with its number: the description reads «arriendo».
    const cutEnd =
      amountEnd + ((isAsk ? tokenMatch : multiplierMatch)?.[0].length ?? 0);
    description = `${text.slice(0, amountMatch.index)} ${text.slice(cutEnd)}`;
  }
  if (matchedCategory) {
    const pattern = new RegExp(escapeRegExp(matchedCategory.name.trim()), "i");
    description = description.replace(pattern, " ");
  }
  description = description.replace(/\s+/g, " ").trim();

  return {
    amountPesos,
    ask,
    categoryId: matchedCategory?.id ?? null,
    description,
    // A uniquely named bank tail outranks the last-used fallback (RF-97, RF-22).
    accountId: matchedAccountId ?? ctx.defaultAccountId,
    direction: INCOME_PATTERN.test(text)
      ? "income"
      : EXPENSE_PATTERN.test(text)
        ? "expense"
        : null,
    occurredAt: readOccurredAt(text),
  };
}
