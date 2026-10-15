import { type CurrencyCode, minorUnitExponent } from "@/lib/currency";
import { FORMAT_LOCALE, type Locale } from "@/lib/locales";

// Two scales live here, and they are not the same one (RNF-05).
//
// The stored scale is hundredths of the major unit, for every currency alike.
// The ledger was written when the peso was the only currency and every amount
// column has held hundredths of a peso since the first row: 350.000 pesos is
// the integer 35000000. The scale belongs to the column, not to the code the
// row carries, so nothing has to be rewritten to let a second currency in.
//
// The written exponent is how many decimals a person types and reads, and that
// one does come from the currency: `Intl` says the peso has no circulating
// coin below itself, so a peso amount is written without decimals, while a
// dollar amount is written with two. Reading the stored scale off `Intl` is
// what would write an amount a hundred times too small.
const STORAGE_EXPONENT = 2;
const STORAGE_UNIT = 10 ** STORAGE_EXPONENT;

type AmountScale = {
  // The divisor between the integer the column keeps and the amount it stands
  // for. The same for every currency, and asked of the currency anyway, so the
  // two scales are read side by side and neither is taken for the other.
  stored: number;
  // Decimals a person types and a figure draws. Never finer than the column
  // keeps: a digit the row cannot hold is one a field must not accept.
  written: number;
};

function amountScale(currency: CurrencyCode): AmountScale {
  return {
    stored: STORAGE_UNIT,
    written: Math.min(minorUnitExponent(currency), STORAGE_EXPONENT),
  };
}

// Eleven nines of the major unit is comfortably past any fund this app will
// ever hold. Carried into the stored scale it lands at 9.9999999999e12, three
// decimal orders under `Number.MAX_SAFE_INTEGER`.
const MAX_AMOUNT_MAJOR = 99_999_999_999;

export function maxAmountMinor(currency: CurrencyCode): number {
  return MAX_AMOUNT_MAJOR * amountScale(currency).stored;
}

// Strips the separators `Intl.NumberFormat` writes and the ones a person types
// by hand, so a pasted "500.000" and a typed "500000" parse the same. Bank
// messages may append zero decimals in either locale.
// Only a separator sitting where a thousands group falls — exactly three
// digits, then another separator or the end — is a group mark; anything else
// is left in place so "500.5" still reads as a decimal, not a group.
function normalizeGroupMarks(raw: string): string {
  const withoutZeroFraction = raw.trim().replace(/[.,]00$/, "");
  return withoutZeroFraction.replace(/[.,   ](?=\d{3}(?:\D|$))/g, "");
}

// Reads a written figure into the integer the stored scale counts. The ceiling
// on the decimals a string may carry is the column's own scale, not a
// currency's write convention (RF-126): the peso column has kept hundredths
// since the first row, whatever `Intl` says the peso circulates a coin down
// to, so a bank's interest, its 4x1000 or a settled foreign purchase reaches
// the column exactly instead of being turned away for a digit it can hold.
//
// Never `parseFloat`, never `Number()` on the whole string, never `* 100`:
// major and fraction are read as separate digit runs and combined with
// integer arithmetic, so no amount ever passes through a binary fraction.
function parseWritten(raw: string): number | null {
  const trimmed = raw.trim();

  // A lone separator with exactly three digits behind it and nothing after
  // reads as a thousands group and nothing else: a genuine fraction can never
  // run three digits deep, since the column holds at most `STORAGE_EXPONENT`,
  // so "1.500" is the same one thousand five hundred whichever currency asked.
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(normalizeGroupMarks(trimmed));
  if (!match) return null;

  const [, major, fraction = ""] = match;
  // A third decimal digit is rejected, not rounded: nothing a bank posts
  // needs a thousandth of its own minor unit, so a third digit is a
  // transcription slip, and guessing a rounding direction would silently
  // move real money instead of asking for the figure again.
  if (fraction.length > STORAGE_EXPONENT) return null;

  const value =
    Number(major) * STORAGE_UNIT +
    Number(fraction.padEnd(STORAGE_EXPONENT, "0") || 0);

  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A typed amount as the integer the ledger stores, or `null` when it is not
 * one. Takes up to the two decimals the column keeps, for every currency
 * alike (RF-126) — not the currency's own write convention, which is a fact
 * about circulating coins and not about what a bank posts. No sign and no
 * exponent: a negative or fractional stored amount is not a value a form
 * takes.
 *
 * The result is in the stored scale, not in the currency's own minor unit:
 * "1000" pesos comes back as 100000, the same integer the column already holds
 * for a thousand pesos. The stored scale is fixed for every currency alike, so
 * no currency travels here any more; `maxAmountMinor(currency)` is still where
 * a caller bounds the result by one.
 */
export function parseAmount(raw: string): number | null {
  return parseWritten(raw);
}

/**
 * What the amount field shows for a stored figure. Writes the decimal mark
 * Spanish uses, the language the copy is written in; `parseAmount` reads either
 * mark back, so a person may still type the other one.
 */
export function amountToInput(minor: number, currency: CurrencyCode): string {
  const { stored, written } = amountScale(currency);
  const major = Math.trunc(minor / stored);
  const remainder = Math.abs(minor) % stored;

  if (remainder === 0 && written === 0) return String(major);

  // How many stored units one written decimal is worth: one, wherever the two
  // scales meet. A remainder finer than that (RF-126: a peso's own centavos,
  // real since a bank posts them) cannot be dropped here as it could be
  // before — the column already holds it, and truncating it in a field that
  // resubmits unchanged is how opening the amount would shrink it. Widen to
  // the stored decimals only when the convention's own step does not divide
  // the remainder evenly; a round figure still shows the currency's usual
  // decimal count.
  const step = stored / 10 ** written;
  const evenlyWritten = remainder % step === 0;
  const decimals = evenlyWritten ? written : STORAGE_EXPONENT;
  const fraction = evenlyWritten ? remainder / step : remainder;

  return `${major},${String(fraction).padStart(decimals, "0")}`;
}

/**
 * The quotient of the two amounts a cross-currency movement carries (RF-122).
 * The one float in this module: it exists to be read, and it is never
 * multiplied back out into an amount that gets stored.
 */
export function deriveRate(
  amountMinor: number,
  from: CurrencyCode,
  counterMinor: number,
  to: CurrencyCode,
): number {
  const amount = amountMinor / amountScale(from).stored;
  const counter = counterMinor / amountScale(to).stored;

  return counter / amount;
}

// Built per language and per currency, and kept: a screen draws fifty figures,
// and constructing a formatter costs more than the figure it writes.
const FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * The magnitude of an amount, drawn in its currency and in the region the
 * language belongs to (RF-125). The one path from a stored integer to a figure:
 * `Money` composes over this and adds the sign, the tone and the estimate mark,
 * which only the primitive knows about. A message that interpolates an amount
 * calls it directly, since JSX cannot travel through `t()`.
 *
 * Takes a magnitude on purpose, applying `Math.abs` itself, so no sign can
 * leave here: `Intl` writes a hyphen-minus, and the only minus this app draws
 * is the primitive's U+2212 (SPEC-A3).
 *
 * The locale is a parameter, not a hook: half the callers are not components.
 */
export function formatMoney(
  minor: number,
  currency: CurrencyCode,
  locale: Locale,
): string {
  const { stored, written } = amountScale(currency);
  const key = `${locale}:${currency}`;
  let formatter = FORMATTERS.get(key);

  if (!formatter) {
    // Not a next-intl named format: one carries no locale, and a figure is
    // drawn for the region a language belongs to, not for the bare language.
    formatter = new Intl.NumberFormat(FORMAT_LOCALE[locale], {
      style: "currency",
      currency,
      minimumFractionDigits: written,
      maximumFractionDigits: written,
    });
    FORMATTERS.set(key, formatter);
  }

  // Truncates to the decimals the currency is written with — RF-125 draws a
  // peso figure without them, whatever a row's own hundredths hold, since
  // COP's coins stop at the peso. A movement can carry peso centavos now
  // (RF-126: a bank's interest, its 4x1000, a settled foreign purchase), and
  // this read-only figure is not where that survives a save: unlike
  // `amountToInput`, nothing here is resubmitted, so hiding the centavos
  // changes no stored row, only what this one draw shows.
  const step = stored / 10 ** written;
  const value = Math.trunc(Math.abs(minor) / step) / 10 ** written;

  return formatter.format(value);
}

// COP-only wrappers, marked to retire. Forty-five files still call them, from
// when every amount was a peso stored as a hundredth of itself. Each caller
// drops its own as the screen it serves starts carrying a currency (RF-121).
// They count whole pesos, which is a third scale and the reason they go: only
// `pesosToCents` bridges them to the integer a column holds.

/** @deprecated Bound an amount with `maxAmountMinor(currency)`. */
export const MAX_AMOUNT_PESOS = MAX_AMOUNT_MAJOR;

/** @deprecated Normalising is `parseAmount`'s own business. */
export function normalizeAmountInput(raw: string): string {
  return normalizeGroupMarks(raw);
}

/**
 * @deprecated Parse with `parseAmount(raw)`, which keeps the centavos this
 * refuses. Kept only for a caller still bound to whole pesos through
 * `pesosToCents`'s own `* 100`, which a fractional peso count would not
 * survive as a float.
 *
 * A remainder finer than one peso is refused, not truncated: RF-95 says these
 * callers take no fractional peso, and dropping the centavos instead wrote
 * "12,45" to the ledger as 12,00 and read "0,45" as an amount that was never
 * there. Refusing says so; truncating loses a person's money in silence.
 */
export function parsePesos(raw: string): number | null {
  const minor = parseAmount(raw);
  if (minor === null || minor % STORAGE_UNIT !== 0) return null;
  return minor / STORAGE_UNIT;
}

// Splits a finite number's shortest round-trip decimal string (what a person
// typed or a cell displays) into an integer mantissa and a power-of-ten
// exponent, so arithmetic on it stays on integers.
function toDecimalParts(n: number): { mantissa: bigint; exp: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(n));
  if (match === null) throw new RangeError("not a finite number");
  const [, sign, whole, frac = "", exp = "0"] = match;
  const mantissa = BigInt(whole + frac);
  return {
    mantissa: sign === "-" ? -mantissa : mantissa,
    exp: Number(exp) - frac.length,
  };
}

// value * 10^shift as an integer, rounded half away from zero (a negative
// shift divides). The one rounding rule for every conversion below.
const ZERO = BigInt(0);
const TWO = BigInt(2);
const TEN = BigInt(10);

function scaleRound(mantissa: bigint, shift: number): bigint {
  if (shift >= 0) return mantissa * TEN ** BigInt(shift);
  const divisor = TEN ** BigInt(-shift);
  const abs = mantissa < ZERO ? -mantissa : mantissa;
  const rounded = (abs * TWO + divisor) / (divisor * TWO);
  return mantissa < ZERO ? -rounded : rounded;
}

/**
 * Converts a decimal peso count to the integer the column stores. Reads the
 * number's shortest decimal form, never `pesos * 100`: 1.15 * 100 is
 * 114.99999999999999. Beyond the stored scale it rounds half away from zero.
 * @deprecated An amount is already stored in the scale a column keeps.
 */
export function pesosToCents(pesos: number): number {
  const { mantissa, exp } = toDecimalParts(pesos);
  return Number(scaleRound(mantissa, exp + STORAGE_EXPONENT));
}

/**
 * Converts `amountMinor` at an exchange `rate` (a float from a public source)
 * to minor units, on integers: the product is taken on the rate's shortest
 * decimal form and rounded once, half away from zero.
 */
export function convertMinor(amountMinor: number, rate: number): number {
  const { mantissa, exp } = toDecimalParts(rate);
  return Number(scaleRound(BigInt(amountMinor) * mantissa, exp));
}

/** @deprecated Formatting an amount is `Money`'s own business. */
export function centsToPesos(cents: number): number {
  return cents / 100;
}
