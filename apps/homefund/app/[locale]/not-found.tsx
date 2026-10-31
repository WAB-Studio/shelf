import { useTranslations } from "next-intl";

import { AppMark, Box, Button, Flex, Heading, Text } from "@/components/ui";
import { Link as LocaleLink } from "@/i18n/navigation";

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
        <AppMark size={56} />
        <Heading size="8" align="center">
          {t("errors.notFoundTitle")}
        </Heading>
        <Box maxWidth="65ch">
          <Text color="gray" align="center">
            {t("errors.notFoundDescription")}
          </Text>
        </Box>
        <Button asChild size="3">
          <LocaleLink href="/">{t("common.backHome")}</LocaleLink>
        </Button>
      </main>
    </Flex>
  );
}
