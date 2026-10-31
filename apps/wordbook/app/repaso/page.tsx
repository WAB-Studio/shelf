import { getTranslations } from "next-intl/server";

import { SideColumn } from "@/components/review/side-column";
import { ReviewSession } from "@/components/review/review-session";
import { Band, Flex, Page } from "@/components/ui";

// RL-68: the review reads the record and its cards off the device alone, so the server draws the shell.
export default async function RepasoPage() {
  const t = await getTranslations("review");
  return (
    <Page aside={<SideColumn section="review" />}>
      <Flex direction="column" gap="5">
        <Band>{t("title")}</Band>
        <ReviewSession />
      </Flex>
    </Page>
  );
}
