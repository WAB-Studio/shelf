import { getTranslations } from "next-intl/server";

import { ClearPanel } from "@/components/log/clear-panel";
import { ExportPanel } from "@/components/log/export-panel";
import { HistoryList } from "@/components/log/history-list";
import { SyncOnOpen } from "@/components/sync/sync-on-open";
import { getReader } from "@/lib/session";
import { Flex, Headword, Page } from "@/components/ui";

// Server-rendered shell alone, like `/fuente`: the study and the two actions
// under it belong to the client components this mounts, in the order the
// `RegistroVaciar` board draws them — the rows carry the screen, the
// download and the wipe sit under them, side by side. No `useDictionary`
// here, so no second Worker parses the payload on a screen that never looks
// a word up (RNL-08). `measure="full"`: Registro is a list, not prose, so it
// takes the width it needs (docs/voyager/DESIGN.md "Viewport").
export default async function RegistroPage() {
  const t = await getTranslations("log");
  // A boolean only, never the reader itself: `ClearPanel` decides whether
  // to draw the account option from this alone (`RegistroVaciarConfirmarSinCuenta`).
  const reader = await getReader();

  return (
    <Page measure="full">
      <SyncOnOpen />
      <Flex direction="column" gap="5">
        <Headword>{t("title")}</Headword>

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
