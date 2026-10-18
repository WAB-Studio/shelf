import { isCivilDate } from "@/lib/dates";
import { normalizeAmountInput } from "@/lib/money";

// Quick entry reads one text field and proposes an editable movement (RF-22).
// Everything it returns is a proposal the form may overwrite; a field is null
// when nothing matched. It is pure: no DB, no async, no side effect.

// The first run of digits, optionally carrying the thousands separators a
// person types by hand; `normalizeAmountInput` strips those to a peso string.
const AMOUNT_PATTERN = /\d[\d.,]*\d|\d/;
// A spoken multiplier right after the amount (RF-22): «mil» and «k» are a
// thousand, «m», «millón» and «millones» a million. A letter or digit after the
// token makes it part of a word: «3 milanesas», «4 kg», «4 m2».
const MULTIPLIER_PATTERN =
  /^\s*(millones|mill[oó]n|mil|k|m)(?![\p{L}\p{N}_])/iu;
// A spaced «m» is a million only as the last word: «2 m», but «5 m de cable» is
// five metres. Glued, «5m» is a million wherever it stands.
const SPACED_M_PATTERN = /^\s+m$/iu;
// «mil» standing as its own word with no digits before it: «pagué mil» is a
// thousand pesos, never a million.
const BARE_THOUSAND_PATTERN = /(?<![\p{L}\p{N}_])mil(?![\p{L}\p{N}_])/iu;
const BARE_THOUSAND_PESOS = "1000";
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

interface QuickEntryProposal {
  amountPesos: string | null;
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

  const digitsMatch = AMOUNT_PATTERN.exec(text);
  const bareThousand = BARE_THOUSAND_PATTERN.exec(text);
  const amountMatch =
    bareThousand && (!digitsMatch || bareThousand.index < digitsMatch.index)
      ? bareThousand
      : digitsMatch;
  const isBareThousand = amountMatch !== null && amountMatch === bareThousand;
  const amountEnd = amountMatch ? amountMatch.index + amountMatch[0].length : 0;
  const afterAmount = text.slice(amountEnd);
  const tokenMatch =
    amountMatch && !isBareThousand ? MULTIPLIER_PATTERN.exec(afterAmount) : null;
  const multiplierMatch =
    tokenMatch &&
    tokenMatch[1].toLowerCase() === "m" &&
    /^\s/u.test(tokenMatch[0]) &&
    !SPACED_M_PATTERN.test(afterAmount.trimEnd())
      ? null
      : tokenMatch;
  const amountPesos = !amountMatch
    ? null
    : isBareThousand
      ? BARE_THOUSAND_PESOS
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
    const cutEnd = amountEnd + (multiplierMatch?.[0].length ?? 0);
    description = `${text.slice(0, amountMatch.index)} ${text.slice(cutEnd)}`;
  }
  if (matchedCategory) {
    const pattern = new RegExp(escapeRegExp(matchedCategory.name.trim()), "i");
    description = description.replace(pattern, " ");
  }
  description = description.replace(/\s+/g, " ").trim();

  return {
    amountPesos,
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
