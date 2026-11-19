"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { civilDay } from "@/lib/format/zone";
import { lookupInstalled } from "@/lib/dictionary/lookup-many";
import { buildAnkiExport, readAnkiCounts } from "@/lib/log/anki";
import { LOG_DELETED_EVENT } from "@/lib/log/delete";
import { buildExport } from "@/lib/log/export";
import { countRecords, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import { CLEAR_ASKED_EVENT } from "@/components/log/clear-panel";
import { Button, Flex, Menu, Separator, Text } from "@/components/ui";

type CountState = { kind: "loading" } | { kind: "ready"; count: number } | { kind: "failed" };
type ExportState = { kind: "idle" } | { kind: "building" } | { kind: "done" } | { kind: "failed" };
type AnkiState =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "done"; cards: number; skipped: number; pending: number; plain: boolean }
  | { kind: "failed" };
type AnkiCounts = { kind: "loading" } | { kind: "ready"; cards: number; words: number; pending: number; skipped: number } | { kind: "failed" };

// `registro-lecturas-<YYYY-MM-DD>.json`, the file name the contract fixes.
function exportFileName(now: Date, suffix = ".json"): string {
  return `registro-lecturas-${civilDay(now.getTime())}${suffix}`;
}

// Downloads a blob without a server round trip: an anchor with a `download`
// attribute and an object URL, never a `<form>` post (RNL-08 — nothing here
// leaves the device).
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// The record's two files and its wipe behind one «Descargar» button; what they report sits under it.
export function DownloadMenu() {
  const t = useTranslations("log");
  const tWord = useTranslations("word");
  const [countState, setCountState] = useState<CountState>({ kind: "loading" });
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [ankiCounts, setAnkiCounts] = useState<AnkiCounts>({ kind: "loading" });
  const [ankiState, setAnkiState] = useState<AnkiState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    // Bumped on every count this effect starts, so a reply superseded by a
    // newer one — a clear firing mid-count — never overwrites it.
    let requestId = 0;

    function count(): void {
      const thisRequest = ++requestId;
      countRecords()
        .then((value) => {
          if (cancelled || thisRequest !== requestId) return;
          setCountState({ kind: "ready", count: value });
        })
        .catch(() => {
          if (!cancelled && thisRequest === requestId) setCountState({ kind: "failed" });
        });
      // The card count rides the same request id: the newer reply wins.
      readAnkiCounts()
        .then(({ cards, words, pending, skipped }) => {
          if (cancelled || thisRequest !== requestId) return;
          setAnkiCounts({ kind: "ready", cards, words, pending, skipped });
        })
        .catch(() => {
          if (!cancelled && thisRequest === requestId) setAnkiCounts({ kind: "failed" });
        });
    }

    count();
    // A clear or a flush changes what this panel offers to download without
    // reloading the page: `LOG_CLEARED_EVENT` can drop the count to zero,
    // which hides the link (`history-list.tsx` rereads its own list the
    // same way).
    window.addEventListener(LOG_CLEARED_EVENT, count);
    window.addEventListener(LOG_FLUSHED_EVENT, count);
    // A delete or a pull changes the rows both files are built from.
    window.addEventListener(LOG_DELETED_EVENT, count);
    window.addEventListener(SYNC_LANDED_EVENT, count);
    return () => {
      cancelled = true;
      window.removeEventListener(LOG_CLEARED_EVENT, count);
      window.removeEventListener(LOG_FLUSHED_EVENT, count);
      window.removeEventListener(LOG_DELETED_EVENT, count);
      window.removeEventListener(SYNC_LANDED_EVENT, count);
    };
  }, []);

  async function handleExport(): Promise<void> {
    setExportState({ kind: "building" });
    try {
      const payload = await buildExport();
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      downloadBlob(blob, exportFileName(new Date()));
      setExportState({ kind: "done" });
    } catch {
      setExportState({ kind: "failed" });
    }
  }

  async function handleAnki(): Promise<void> {
    setAnkiState({ kind: "building" });
    try {
      // The dictionary's Worker is raised here, for this download alone: opening `/registro` mounts none (RNL-08).
      const { csv, cards, skipped, pending, plain } = await buildAnkiExport(
        { pos: (pos) => tWord(`pos.${pos}`) },
        lookupInstalled,
      );
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), exportFileName(new Date(), "-anki.csv"));
      setAnkiState({ kind: "done", cards, skipped, pending, plain });
    } catch {
      setAnkiState({ kind: "failed" });
    }
  }

  // An empty record has no file worth offering.
  if (countState.kind === "ready" && countState.count === 0) return null;

  const loading = countState.kind === "loading";
  // No card to give: the item is gone and its place says why (RL-72). Until the count is known the
  // item does not draw; a failed count draws it, and the click builds and reports.
  const ankiOffered = ankiCounts.kind === "failed" || (ankiCounts.kind === "ready" && ankiCounts.cards > 0);

  return (
    <Flex direction="column" gap="2" align="end">
      <Menu.Root>
        <Menu.Trigger>
          <Button size="3" variant="soft" disabled={loading} aria-busy={loading}>
            {t("study.downloadMenu")}
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
        </Menu.Trigger>
        <Menu.Content align="end">
          <Menu.Item disabled={exportState.kind === "building"} onSelect={() => void handleExport()}>
            {t("study.download")}
          </Menu.Item>
          {ankiOffered && (
            <Menu.Item disabled={ankiState.kind === "building"} onSelect={() => void handleAnki()}>
              {t("study.downloadAnki")}
            </Menu.Item>
          )}
          {/* Words that wait are not «sin traducción guardada»: with any, the no-card line gives way to
              the waiting line and the left-out one. */}
          {ankiCounts.kind === "ready" && ankiCounts.cards === 0 && ankiCounts.pending > 0 && (
            <>
              <Menu.Note>{t("study.ankiPending", { count: ankiCounts.pending })}</Menu.Note>
              {ankiCounts.skipped > 0 && <Menu.Note>{t("study.ankiSkipped", { count: ankiCounts.skipped })}</Menu.Note>}
            </>
          )}
          {ankiCounts.kind === "ready" && ankiCounts.cards === 0 && ankiCounts.pending === 0 && (
            <Menu.Note>{t("study.ankiNone", { words: ankiCounts.words })}</Menu.Note>
          )}
          <Menu.Separator />
          <Menu.Item onSelect={() => window.dispatchEvent(new Event(CLEAR_ASKED_EVENT))}>
            {t("clear.trigger")}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>

      <Flex direction="column" gap="1" align="end" role="status">
        {countState.kind === "failed" && (
          <Text size="2" muted>
            {t("countFailed")}
          </Text>
        )}
        {exportState.kind === "building" && (
          <Text size="2" muted>
            {t("exporting")}
          </Text>
        )}
        {exportState.kind === "done" && (
          <Text size="2" muted>
            {t("exported")}
          </Text>
        )}
        {exportState.kind === "failed" && (
          <Text size="2" muted>
            {t("exportFailed")}
          </Text>
        )}
        {ankiState.kind === "building" && (
          <Text size="2" muted>
            {t("study.ankiPreparing")}
          </Text>
        )}
        {ankiState.kind === "done" && (
          <>
            <Text size="2" muted>
              {t("study.ankiDone", { cards: ankiState.cards })}
            </Text>
            {ankiState.plain && (
              <Text size="2" muted>
                {t("study.ankiPlain")}
              </Text>
            )}
            {ankiState.pending > 0 && (
              <Text size="2" muted>
                {t("study.ankiPending", { count: ankiState.pending })}
              </Text>
            )}
            {ankiState.skipped > 0 && (
              <Text size="2" muted>
                {t("study.ankiSkipped", { count: ankiState.skipped })}
              </Text>
            )}
          </>
        )}
      </Flex>

      {ankiState.kind === "failed" && (
        <Flex direction="column" gap="3" align="end">
          <Separator size="4" />
          <Text size="2" weight="bold">
            {t("study.ankiFailed")}
          </Text>
          <Button size="2" onClick={() => void handleAnki()}>
            {t("retry")}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}
