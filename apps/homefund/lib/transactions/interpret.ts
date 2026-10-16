import { isCivilDate } from "@/lib/dates";
import { normalizeAmountInput } from "@/lib/money";

// Quick entry reads one text field and proposes an editable movement (RF-22).
// Everything it returns is a proposal the form may overwrite; a field is null
// when nothing matched. It is pure: no DB, no async, no side effect.

// The first run of digits, optionally carrying the thousands separators a
// person types by hand; `normalizeAmountInput` strips those to a peso string.
const AMOUNT_PATTERN = /\d[\d.,]*\d|\d/;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function interpretQuickEntry(
  text: string,
  ctx: InterpretContext,
): QuickEntryProposal {
  const lower = text.toLowerCase();

  const amountMatch = AMOUNT_PATTERN.exec(text);
  const amountPesos = amountMatch
    ? normalizeAmountInput(amountMatch[0])
    : null;
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

  // What is left once the amount and any matched category token are removed.
  let description = text;
  if (amountMatch) {
    description = description.replace(amountMatch[0], " ");
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
