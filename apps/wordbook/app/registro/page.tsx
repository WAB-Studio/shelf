import NextLink from "next/link";
import { getTranslations } from "next-intl/server";

import { ClearPanel } from "@/components/log/clear-panel";
import { ExportPanel } from "@/components/log/export-panel";
import { HistoryList } from "@/components/log/history-list";
import { SyncOnDelete } from "@/components/sync/sync-on-delete";
import { SyncOnOpen } from "@/components/sync/sync-on-open";
import { getReader } from "@/lib/session";
import { Button, Flex, Headword, Page } from "@/components/ui";

// Server-rendered shell alone, like `/fuente`: the study and the two actions
// under it belong to the client components this mounts, in the order the
// `RegistroVaciar` board draws them — the rows carry the screen, the
// download and the wipe sit under them, side by side. No `useDictionary`
// here, so no second Worker parses the payload on a screen that never looks
// a word up (RNL-08). `measure="full"`: Registro is a list, not prose, so it
// takes the width it needs (docs/wordbook/DESIGN.md "Viewport").
export default async function RegistroPage() {
  // `reader`: a boolean only, never the reader itself: `ClearPanel` decides whether
  // to draw the account option from this alone (`RegistroVaciarConfirmarSinCuenta`).
  const [t, tReview, reader] = await Promise.all([getTranslations("log"), getTranslations("review"), getReader()]);

  return (
    <Page measure="full">
      <SyncOnOpen />
      <SyncOnDelete />
      <Flex direction="column" gap="5">
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <Headword>{t("title")}</Headword>
          {/* RL-68: the review draws its words from this record. */}
          <Button asChild size="3" variant="soft">
            <NextLink href="/repaso">{tReview("open")}</NextLink>
          </Button>
        </Flex>

        <HistoryList />

        {/* `wrap="wrap"`, not two fixed columns: `ClearPanel`'s own confirm
            block sets `width="100%"`, so a wide flex item forces itself onto
            its own line under the download link rather than squeezing
            beside it (`RegistroVaciarConfirmar`'s board — the confirm falls
            below the row, never inside it). */}
        <Flex gap="4" wrap="wrap">
          <ExportPanel />
          <ClearPanel hasReader={reader !== null} />
        </Flex>
      </Flex>
    </Page>
  );
}
