import Link from "next/link";
import { useTranslations } from "next-intl";

import { Button, Page, ScreenHeader, Text } from "@/components/ui";

// No button that approves: a request that cannot be trusted has nothing to grant.
export function Invalid() {
  const t = useTranslations("oauth");

  return (
    <Page alone middle>
      <ScreenHeader title={t("invalid.title")} eyebrow={t("eyebrow")} />
      <Text as="p">{t("invalid.body")}</Text>
      <Button asChild variant="outline" tap={52} block>
        <Link href="/">{t("invalid.home")}</Link>
      </Button>
    </Page>
  );
}
