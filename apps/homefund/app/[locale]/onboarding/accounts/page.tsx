import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OnboardingAccountsStep } from "@/components/onboarding/onboarding-accounts-step";
import { OnboardingStepper } from "@/components/onboarding/onboarding-stepper";
import { Flex, Heading, Text } from "@/components/ui";
import { listAccounts } from "@/db/queries/accounts";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/onboarding/accounts">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "metadata" });

  return {
    title: t("onboardingTitle"),
    description: t("onboardingDescription"),
  };
}

export default async function OnboardingAccountsPage(
  props: PageProps<"/[locale]/onboarding/accounts">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [, group, accounts, t] = await Promise.all([
    requireUser(),
    getUserGroup(),
    listAccounts({ archived: false }),
    getTranslations("onboarding.accountsStep"),
  ]);

  // Step two presumes the fund from step one; without it the flow restarts.
  if (!group) return redirect({ href: "/onboarding", locale });

  return (
    <Flex asChild direction="column" gap="5">
      <main>
        <OnboardingStepper current={2} />
        <Flex direction="column" gap="2">
          <Heading size="7">{t("title")}</Heading>
          <Text color="gray">{t("subtitle")}</Text>
        </Flex>
        <OnboardingAccountsStep accounts={accounts} groupName={group.name} />
      </main>
    </Flex>
  );
}
