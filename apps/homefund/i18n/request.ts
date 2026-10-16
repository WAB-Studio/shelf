import { hasLocale, type Messages } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { locale as rootLocale } from "next/root-params";

import { BASE_CURRENCY, minorUnitExponent } from "@/lib/currency";
import { DEFAULT_LOCALE, TIME_ZONE } from "@/lib/locales";
import type en from "../messages/en.json";
import { routing } from "./routing";

// Spanish is the source of truth; `skipLibCheck` would ignore this in `global.d.ts`.
type Catalogue<T extends Messages> = T;
export type EnglishCatalogue = Catalogue<typeof en>;

/**
 * `next/root-params` only answers inside a Server Component render. A server
 * action reaches the config outside one and throws, so it reads the locale the
 * proxy forwarded instead.
 */
async function segmentLocale(requestLocale: Promise<string | undefined>) {
  try {
    return await rootLocale();
  } catch {
    return requestLocale;
  }
}

export default getRequestConfig(async ({ locale: explicit, requestLocale }) => {
  // An explicit `getTranslations({ locale })` wins, as it does for route handlers and metadata.
  // The segment doubles as a catch-all, so anything unknown falls back instead of throwing.
  const requested = explicit ?? (await segmentLocale(requestLocale));
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // Fixed, not the visitor's: the fund books every movement in one zone.
    timeZone: TIME_ZONE,
    formats: {
      number: {
        // What is left of a one-currency app, not the policy: a movement's
        // currency is a column, and next-intl resolves a named format once for
        // the whole request. `Money` formats per currency; the calls still
        // reaching for this name are the ones not yet carrying one (RF-121).
        currency: {
          style: "currency",
          currency: BASE_CURRENCY,
          minimumFractionDigits: minorUnitExponent(BASE_CURRENCY),
          maximumFractionDigits: minorUnitExponent(BASE_CURRENCY),
        },
      },
    },
  };
});
