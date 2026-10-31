import NextLink from "next/link";
import { getTranslations } from "next-intl/server";

import { ClearPanel } from "@/components/log/clear-panel";
import { ExportPanel } from "@/components/log/export-panel";
import { HistoryList } from "@/components/log/history-list";
import { SyncOnDelete } from "@/components/sync/sync-on-delete";
import { SyncOnOpen } from "@/components/sync/sync-on-open";
import { getReader } from "@/lib/session";
import { Band, Box, Button, Flex, Page, Separator } from "@/components/ui";

// Server-rendered shell alone, like `/fuente`: the study and the two actions
// under it belong to the client components this mounts, in the order the
// `RegistroVaciar` board draws them — the rows carry the screen, the
// downloads sit under them in a card and the wipe apart, under a hairline. No `useDictionary`
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
          <Box flexGrow="1">
            <Band>{t("title")}</Band>
          </Box>
          {/* RL-68: the review draws its words from this record. */}
          <Button asChild size="3" variant="soft">
            <NextLink href="/repaso">{tReview("open")}</NextLink>
          </Button>
        </Flex>

        <HistoryList />

        {/* The downloads together in one card; emptying the record sits apart under a hairline,
            quiet, so it is never a neighbour of the safe actions. */}
        <ExportPanel />
        <Separator size="4" />
        <Flex justify="end">
          <ClearPanel hasReader={reader !== null} />
        </Flex>
      </Flex>
    </Page>
  );
}
