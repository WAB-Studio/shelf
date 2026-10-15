import { CheckIcon } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge, Box, Button, Flex, Heading, Text } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { Link as LocaleLink, redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/bienvenida">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "metadata" });

  return {
    title: t("title"),
    description: t("description"),
  };
}

// Landing after the confirm route claims an invite (RF-06): no app shell, so
// the accepting person reads the confirmation before entering the fund.
export default async function WelcomePage(
  props: PageProps<"/[locale]/bienvenida">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // The guard fans out with the read it protects, never ahead of it.
  const [, group] = await Promise.all([requireUser(), getUserGroup()]);
  // Reached without a claimed membership only by a stray visit; send them home.
  if (!group) return redirect({ href: "/", locale });

  const t = await getTranslations("bienvenida");

  return (
    <Flex
      asChild
      direction="column"
      align="center"
      justify="center"
      flexGrow="1"
      gap="4"
      p="6"
      width="100%"
      maxWidth={{ initial: "100%", md: "35rem" }}
      mx={{ md: "auto" }}
    >
      <main>
        <Flex
          align="center"
          justify="center"
          style={{
            width: 96,
            height: 96,
            borderRadius: "50%",
            backgroundColor: "var(--accent-9)",
          }}
        >
          <CheckIcon
            size={46}
            color="var(--accent-contrast)"
            strokeWidth={2.4}
            aria-hidden
          />
        </Flex>

        <Heading size="6" align="center">
          {t("title", { fund: group.name })}
        </Heading>

        <Box maxWidth="65ch">
          <Text color="gray" align="center">
            {t("subtitle")}
          </Text>
        </Box>

        <Badge size="2" radius="full" variant="soft" color="gray">
          {group.name}
        </Badge>

        <Button asChild size={{ initial: "3", md: "4" }}>
          <LocaleLink href="/">{t("enter")}</LocaleLink>
        </Button>
      </main>
    </Flex>
  );
}
