import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AppHeader } from "@/components/screens/app-header";
import { SignInForm } from "@/components/screens/sign-in-form";
import { Page, Stack, Title } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("time.signIn");
  return { title: t("title") };
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [{ error }, t] = await Promise.all([searchParams, getTranslations("time.signIn")]);
  return (
    <Page>
      <AppHeader signedIn={false} />
      <Stack gap={4}>
        <Title>{t("title")}</Title>
        <SignInForm linkError={error !== undefined} />
      </Stack>
    </Page>
  );
}
