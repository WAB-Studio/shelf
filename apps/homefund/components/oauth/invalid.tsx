import { useTranslations } from "next-intl";

import { AppMark, ButtonLink, Flex, Heading, Text } from "@/components/ui";

// No button that approves: a request that cannot be trusted has nothing to grant.
export function Invalid() {
  const t = useTranslations("oauth");

  return (
    <Flex asChild direction="column" flexGrow="1" align="center" justify="center" p="4">
      <main>
        <Flex direction="column" gap="4" maxWidth="28rem">
          <AppMark size={56} />
          <Heading size="6">{t("invalid.title")}</Heading>
          <Text>{t("invalid.body")}</Text>
          <ButtonLink href="/" variant="outline">
            {t("invalid.home")}
          </ButtonLink>
        </Flex>
      </main>
    </Flex>
  );
}
