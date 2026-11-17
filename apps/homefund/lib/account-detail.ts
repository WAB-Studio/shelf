type Balance = { currency: string; balanceCents: number };

// The words of a text without case or accents: «Mamá — BBVA» reads «mama», «bbva».
function wordsOf(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether an account's name already says who holds it («Mamá — BBVA» for the holder «Mamá»), so Cuentas writes
 * the holder once. The holder's words must appear in the name in a row and whole: «Ana» is not in «Banana».
 */
export function nameCarriesHolder(name: string, holder: string): boolean {
  const target = wordsOf(holder);
  if (target.length === 0) return false;
  const words = wordsOf(name);
  for (let start = 0; start + target.length <= words.length; start += 1) {
    if (target.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Whether the part of an account that sits in the account itself, not in its pockets, is worth a line of its own:
 * it differs from the total in some currency. An account whose pockets hold nothing has nothing to add.
 */
export function holdsMoneyApartFromPockets(own: Balance[], total: Balance[] | undefined): boolean {
  if (!total) return false;
  return total.some((all) => (own.find((part) => part.currency === all.currency)?.balanceCents ?? 0) !== all.balanceCents);
}
