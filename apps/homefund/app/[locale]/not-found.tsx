import { useTranslations } from "next-intl";

import { Box, Flex, Heading, Text, TextLink } from "@/components/ui";

export default function NotFound() {
  const t = useTranslations();

  return (
    <Flex
      asChild
      direction="column"
      align="center"
      justify="center"
      gap="4"
      flexGrow="1"
      p="6"
    >
      <main>
        <Heading size="6" align="center">
          {t("errors.notFoundTitle")}
        </Heading>
        <Box maxWidth="65ch">
          <Text color="gray" align="center">
            {t("errors.notFoundDescription")}
          </Text>
        </Box>
        <TextLink href="/" justify="center" px="2">
          {t("common.backHome")}
        </TextLink>
      </main>
    </Flex>
  );
}
