import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { CircleAlertIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { AppMark, Box, Callout, Card, Flex, Heading, Highlight, Text } from "@/components/ui";
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
  // Set by the sign-out action: this device is signed out, Auth kept the person's other sessions.
  const error = firstValue(searchParams.error);
  const linkNotice =
    error === "linkInvalid" ||
    error === "linkOtherBrowser" ||
    error === "linkTimeout" ||
    error === "signOutPartial"
      ? (`errors.${error}` as const)
      : null;

  return (
    <Flex asChild direction="column" flexGrow="1" p="4">
      <main>
        {/* Language and theme both work signed out (FLOWS §8, §10). */}
        <Flex justify="end" align="center" gap="2" py="2">
          <LanguageSwitcher width="9.5rem" showText />
          <ThemeSwitcher width="9.5rem" showText />
        </Flex>
        <Flex direction="column" flexGrow="1" align="center" justify="center">
          <Box width="100%" maxWidth={{ initial: "24rem", md: "28rem" }}>
            <Flex direction="column" gap="4">
              <Flex direction="column" gap="3">
                <AppMark size={72} />
                <Flex direction="column" gap="2">
                  <Heading size="9">{t("common.appName")}</Heading>
                  <Text size="4">
                    {t.rich("auth.tagline", {
                      mark: (chunks) => <Highlight>{chunks}</Highlight>,
                    })}
                  </Text>
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
              <Flex direction="column" gap="1">
                <Text size="2" weight="medium" align="center">
                  {t("auth.invitationOnly")}
                </Text>
                <Text size="2" color="gray" align="center">
                  {t("auth.passwordlessHint")}
                </Text>
              </Flex>
            </Flex>
          </Box>
        </Flex>
      </main>
    </Flex>
  );
}
