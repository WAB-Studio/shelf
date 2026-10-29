import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OnboardingInviteStep } from "@/components/onboarding/onboarding-invite-step";
import { OnboardingStepper } from "@/components/onboarding/onboarding-stepper";
import { Flex, Heading, Text } from "@/components/ui";
import { getMembersScreenData } from "@/db/queries/group-members";
import { requireUser } from "@/db/session";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/onboarding/invite">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "metadata" });

  return {
    title: t("onboardingTitle"),
    description: t("onboardingDescription"),
  };
}

export default async function OnboardingInvitePage(
  props: PageProps<"/[locale]/onboarding/invite">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [user, data, t] = await Promise.all([
    requireUser(),
    getMembersScreenData({ archived: false }),
    getTranslations("onboarding.inviteStep"),
  ]);

  // The final step presumes the fund from step one; without it the flow restarts.
  if (!data) return redirect({ href: "/onboarding", locale });

  return (
    <Flex asChild direction="column" gap="5">
      <main>
        <OnboardingStepper current={3} />
        <Flex direction="column" gap="2">
          <Heading size="7">{t("title")}</Heading>
          <Text color="gray">{t("subtitle")}</Text>
        </Flex>
        <OnboardingInviteStep members={data.members} currentUserId={user.id} />
      </main>
    </Flex>
  );
}
