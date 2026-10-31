import { cookies, headers } from "next/headers";
import type { Messages } from "next-intl";
import { getRequestConfig } from "next-intl/server";

import { LOCALE_COOKIE, pickLocale } from "@/lib/locale";

// Two locales and no routing: the language is a cookie, so no URL changes with it.
export default getRequestConfig(async () => {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const locale = pickLocale(jar.get(LOCALE_COOKIE)?.value, incoming.get("accept-language"));
  const [common, time] = await Promise.all([import(`../messages/${locale}/common.json`), import(`../messages/${locale}/time.json`)]);

  return { locale, messages: { common: common.default, time: time.default } as unknown as Messages };
});
