import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Button, NoTabMarked, Page, ScreenExit, ScreenHeader } from "@/components/ui";

/**
 * `ArmazonNoEncontrada.dc.html` (RNP-01, RNP-16). Reached from inside the app — `/dia/zzz`,
 * an unknown goal — where `app/(app)/layout.tsx` already draws the nav, so
 * this draws none. No sentence under the title names a route: it serves a
 * date and a goal alike. `app/not-found.tsx` adds the nav for what the app
 * does not route at all.
 */
export default async function NotFound() {
  const t = await getTranslations("common.notFound");

  return (
    <Page width="full">
      <NoTabMarked />
      <ScreenHeader title={t("title")} />
      <ScreenExit message={t("body")}>
        <Button asChild>
          <Link href="/">{t("primaryAction")}</Link>
        </Button>
        <Button asChild variant="ghost" tone="accent">
          <Link href="/metas">{t("secondaryAction")}</Link>
        </Button>
      </ScreenExit>
    </Page>
  );
}
