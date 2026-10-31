import { getTranslations } from "next-intl/server";

import { AppHeader } from "@/components/screens/app-header";
import { Page, Stack, Text, TextLink, Title } from "@/components/ui";

export default async function NotFound() {
  const t = await getTranslations("time.notFound");
  return (
    <Page>
      <AppHeader signedIn={false} />
      <Stack gap={4}>
        <Title>{t("title")}</Title>
        <Text as="p">{t("text")}</Text>
        <TextLink button href="/">{t("back")}</TextLink>
      </Stack>
    </Page>
  );
}
