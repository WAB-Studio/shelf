import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { CircleAlertIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { AppMark, Box, Callout, Card, Flex, Heading, Text } from "@/components/ui";
import { routing } from "@/i18n/routing";

// A path the proxy put in `?next=`, or nothing: a repeated parameter arrives as
// an array and is not a destination.
function firstValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function generateMetadata(
  props: PageProps<"/[locale]/login">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "metadata" });

  return {
    title: t("loginTitle"),
    description: t("loginDescription"),
  };
}

export default async function LoginPage(props: PageProps<"/[locale]/login">) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const searchParams = await props.searchParams;
  const t = await getTranslations();

  // Set by `/auth/confirm`: the link is expired or spent, was opened in a browser that did not ask for it, or Auth did not answer.
  const error = firstValue(searchParams.error);
  const linkNotice =
    error === "linkInvalid" || error === "linkOtherBrowser" || error === "linkTimeout"
      ? (`errors.${error}` as const)
      : null;

  return (
    <Flex asChild direction="column" flexGrow="1" p="4">
      <main>
        {/* Language and theme both work signed out (FLOWS §8, §10). */}
        <Flex justify="end" align="center" gap="2" py="2">
          <LanguageSwitcher />
          <ThemeSwitcher />
        </Flex>
        <Flex direction="column" flexGrow="1" align="center" justify="center">
          <Box width="100%" maxWidth={{ initial: "24rem", md: "28rem" }}>
            <Flex direction="column" gap="4">
              <Flex direction="column" gap="3">
                <AppMark />
                <Flex direction="column" gap="1">
                  <Heading size="7">{t("common.appName")}</Heading>
                  <Text color="gray">{t("auth.tagline")}</Text>
                </Flex>
              </Flex>
              {linkNotice && (
                <Callout.Root color="red" role="alert">
                  <Callout.Icon>
                    <CircleAlertIcon size={16} aria-hidden />
                  </Callout.Icon>
                  <Callout.Text>{t(linkNotice)}</Callout.Text>
                </Callout.Root>
              )}
              <Card>
                <LoginForm next={firstValue(searchParams.next)} />
              </Card>
              <Text size="2" color="gray" align="center">
                {t("auth.passwordlessHint")}
              </Text>
            </Flex>
          </Box>
        </Flex>
      </main>
    </Flex>
  );
}
