import { useTranslations } from "next-intl";

import { Box, Flex, Headword, Page, Text } from "@/components/ui";

export default function NotFound() {
  const t = useTranslations("notFound");

  return (
    <Page>
      <Flex direction="column" align="center" justify="center" gap="4" flexGrow="1">
        <Headword align="center">{t("title")}</Headword>
        <Box maxWidth="45ch">
          <Text muted align="center" as="p">
            {t("description")}
          </Text>
        </Box>
      </Flex>
    </Page>
  );
}
