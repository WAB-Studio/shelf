import { defineRouting } from "next-intl/routing";

import { DEFAULT_LOCALE, LOCALES } from "@/lib/locales";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // The language is part of the URL for every route, including the default one.
  localePrefix: "always",
  localeDetection: true,
});
