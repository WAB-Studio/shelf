import { ChevronLeft } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { Box, Flex, IconButton } from "@/components/ui";
import { Link as LocaleLink } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

// First run gets its own frame (RF-64): a back header and no app shell, so the
// three steps read as a flow apart from the signed-in navigation.
export default async function OnboardingLayout(
  props: LayoutProps<"/[locale]">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const t = await getTranslations("onboarding");

  return (
    <Flex
      direction="column"
      flexGrow="1"
      width="100%"
      maxWidth={{ initial: "30rem", md: "40rem" }}
      mx="auto"
    >
      <Flex align="center" px="4" pt="4" pb="2">
        <IconButton
          asChild
          variant="soft"
          color="gray"
          radius="full"
          size="3"
          aria-label={t("back")}
        >
          <LocaleLink href="/">
            <ChevronLeft size={18} aria-hidden />
          </LocaleLink>
        </IconButton>
      </Flex>
      <Box flexGrow="1" px={{ initial: "5", md: "6" }} pb="6">
        {props.children}
      </Box>
    </Flex>
  );
}
