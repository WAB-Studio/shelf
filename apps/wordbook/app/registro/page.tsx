import { getTranslations } from "next-intl/server";

import { ClearPanel } from "@/components/log/clear-panel";
import { DownloadMenu } from "@/components/log/export-panel";
import { HistoryList } from "@/components/log/history-list";
import { ReviewLink } from "@/components/review/review-link";
import { SyncOnDelete } from "@/components/sync/sync-on-delete";
import { SyncOnOpen } from "@/components/sync/sync-on-open";
import { getReader } from "@/lib/session";
import { PageTitle, Flex, Page } from "@/components/ui";

// Server-rendered shell alone, like `/fuente`: the table and the two actions above it belong to the
// client components this mounts. No `useDictionary` here, so no second Worker parses the payload on
// a screen that never looks a word up (RNL-08). `measure="table"`: Registro is a table, not prose, so
// it takes the width it needs, capped at 1100px so the header's buttons sit over the table's edge
// (docs/wordbook/DESIGN.md "Registro y Repaso en escritorio").
export default async function RecordPage() {
  // `reader`: a boolean only, never the reader itself: `ClearPanel` decides whether
  // to draw the account option from this alone (`RegistroVaciarConfirmarSinCuenta`).
  const [t, reader] = await Promise.all([getTranslations("log"), getReader()]);

  return (
    <Page measure="table">
      <SyncOnOpen />
      <SyncOnDelete />
      <Flex direction="column" gap="5">
        <Flex justify="between" align="start" gap="3" wrap="wrap">
          <PageTitle>{t("title")}</PageTitle>
          <Flex gap="3" align="start" wrap="wrap">
            <DownloadMenu />
            {/* RL-68: the review draws its words from this record. */}
            <ReviewLink />
          </Flex>
        </Flex>

        {/* The question «Vaciar el registro» opens, under the header it was asked from. */}
        <ClearPanel hasReader={reader !== null} />

        <HistoryList />
      </Flex>
    </Page>
  );
}
