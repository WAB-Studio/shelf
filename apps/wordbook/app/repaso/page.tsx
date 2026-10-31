import { getTranslations } from "next-intl/server";

import { ReviewSession } from "@/components/review/review-session";
import { PageTitle, Flex, Page } from "@/components/ui";

// RL-68: the review reads the record and its cards off the device alone, so the server draws the shell.
export default async function RepasoPage() {
  const t = await getTranslations("review");
  return (
    <Page>
      <Flex direction="column" gap="5">
        <PageTitle>{t("title")}</PageTitle>
        <ReviewSession />
      </Flex>
    </Page>
  );
}
