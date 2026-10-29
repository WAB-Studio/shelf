import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CreateFundForm } from "@/components/fund/create-fund-form";
import { OnboardingStepper } from "@/components/onboarding/onboarding-stepper";
import { Flex, Heading, Text } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/onboarding">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "metadata" });

  return {
    title: t("onboardingTitle"),
    description: t("onboardingDescription"),
  };
}

export default async function OnboardingPage(
  props: PageProps<"/[locale]/onboarding">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [, group, t] = await Promise.all([
    requireUser(),
    getUserGroup(),
    getTranslations("onboarding"),
  ]);

  // RF-55: one group per user. A returning leader resumes the flow at the next
  // step; they never fork a second group.
  if (group) redirect({ href: "/onboarding/accounts", locale });

  return (
    <Flex asChild direction="column" gap="5">
      <main>
        <OnboardingStepper current={1} />
        <Flex direction="column" gap="2">
          <Heading size="7">{t("title")}</Heading>
          <Text color="gray">{t("subtitle")}</Text>
        </Flex>
        <CreateFundForm />
      </main>
    </Flex>
  );
}
