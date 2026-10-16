import { useTranslations } from "next-intl";

import { SignInForm } from "@/components/account/sign-in-form";
import { Page } from "@/components/ui";

// `next` is this very screen's path and query: the link brings the person back
// to say yes or no.
export function SignedOut({ client, next }: { client: string; next: string }) {
  const t = useTranslations("oauth");
  return (
    <Page alone middle>
      <SignInForm next={next} send={t("signedOut.send")} title={t("title", { client })} lead={t("signedOut.lead")} />
    </Page>
  );
}
