import { defineRouting } from "next-intl/routing";

import { DEFAULT_LOCALE, LOCALES } from "@/lib/locales";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // The language is part of the URL for every route, including the default one.
  localePrefix: "always",
  // The URL decides, then Spanish (RF-218): no browser language and no saved cookie, so a stale `NEXT_LOCALE=en`
  // left by the old detection decides nothing. English is still a page away at `/en`.
  localeDetection: false,
  localeCookie: false,
});
