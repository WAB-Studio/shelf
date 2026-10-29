import { z } from "zod";

import { DEFAULT_LOCALE } from "@/lib/locales";

// What a currency is worth knowing about lives here and nowhere else (RF-121).
// No table of decimal places is written down: `Intl` already carries every
// currency's minor unit, which is why Dinero.js is on the do-not-install list.

export type CurrencyCode = string;

// The codes a selector offers. A row may still carry another one, so nothing
// here narrows what can be read — only what a person can choose.
//
// Every amount column keeps hundredths of the major unit, whatever the code
// (RNF-05). A currency `Intl` writes with three decimals — the dinar, the
// dinar's neighbours — loses its last digit between the field and the row, so
// it does not go on this list. `lib/money.ts` clips the written decimals to the
// stored scale as a net under that rule, not as support for one.
export const OFFERED_CURRENCIES = ["COP", "USD"] as const;

// What a form may write, as narrow as the schema that validates it. `CurrencyCode`
// stays loose because a column holds any ISO code — a row imported or seeded
// before a currency reached this list still reads. Creation is the other
// direction and has to be narrow, or a screen offers what the schema refuses.
export type OfferedCurrency = (typeof OFFERED_CURRENCIES)[number];

// What a new account, group or person settles in until they say otherwise.
export const BASE_CURRENCY = "COP";

// The same list `Intl` formats against, so a code it accepts is a code the
// interface can render. Built once, on the first call that needs it.
let assignedCodes: Set<string> | null = null;

// ISO 4217: three uppercase letters, and one the runtime actually knows.
export function isCurrencyCode(value: string): boolean {
  if (!/^[A-Z]{3}$/.test(value)) return false;

  assignedCodes ??= new Set(Intl.supportedValuesOf("currency"));
  return assignedCodes.has(value);
}

const exponents = new Map<CurrencyCode, number>();

/**
 * How many decimal places the currency's minor unit is: 0 for the Colombian
 * peso, 2 for the dollar. Read off `Intl`, memoised because resolving a
 * formatter costs more than the lookup it answers.
 *
 * Throws on a code `Intl` cannot parse. Guard untrusted input with
 * `isCurrencyCode` or `currencySchema` first.
 */
export function minorUnitExponent(code: CurrencyCode): number {
  const cached = exponents.get(code);
  if (cached !== undefined) return cached;

  // ECMA-402 always resolves the fraction digits for `style: "currency"`; the
  // lib type marks them optional because compact notation may drop them.
  const digits = new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency: code,
  }).resolvedOptions().minimumFractionDigits!;

  exponents.set(code, digits);
  return digits;
}

// One schema for the form and for the server (RNF-10).
export const currencySchema = z.enum(OFFERED_CURRENCIES);
