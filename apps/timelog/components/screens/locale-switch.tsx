import { getLocale, getTranslations } from "next-intl/server";

import { setLocale } from "@/app/actions/locale";
import { Button } from "@/components/ui";

// One press flips the interface between Spanish and English; the button names the language it goes to.
export async function LocaleSwitch() {
  const [t, locale] = await Promise.all([getTranslations("common"), getLocale()]);
  return (
    <form action={setLocale}>
      <input type="hidden" name="locale" value={locale === "en" ? "es" : "en"} />
      <Button quiet type="submit" aria-label={t("languageLabel")}>
        {t("language")}
      </Button>
    </form>
  );
}
