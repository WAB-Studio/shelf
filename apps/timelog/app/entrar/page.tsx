import { getTranslations } from "next-intl/server";

import { SignInForm } from "@/components/screens/sign-in-form";
import { Page, Stack, Title } from "@/components/ui";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [{ error }, t] = await Promise.all([searchParams, getTranslations("time.signIn")]);
  return (
    <Page>
      <Stack gap={4}>
        <Title>{t("title")}</Title>
        <SignInForm linkError={error !== undefined} />
      </Stack>
    </Page>
  );
}
