import { getTranslations } from "next-intl/server";

import { ReviewSession } from "@/components/review/review-session";
import { PageTitle, Page, Panels } from "@/components/ui";

// RL-68: the review reads the record and its cards off the device alone, so the server draws the shell.
export default async function RepasoPage() {
  const t = await getTranslations("review");
  return (
    <Page measure="panels">
      <Panels top={<PageTitle>{t("title")}</PageTitle>}>
        <ReviewSession />
      </Panels>
    </Page>
  );
}
