"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { buildAnkiExport, readAnkiCounts } from "@/lib/log/anki";
import { LOG_DELETED_EVENT } from "@/lib/log/delete";
import { buildExport } from "@/lib/log/export";
import { countRecords, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import { Button, Flex, Link, Separator, Spinner, TapTarget, Text } from "@/components/ui";

type CountState = { kind: "loading" } | { kind: "ready"; count: number } | { kind: "failed" };
type ExportState = { kind: "idle" } | { kind: "building" } | { kind: "done" } | { kind: "failed" };
type AnkiState =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "done"; cards: number; skipped: number; pending: number }
  | { kind: "failed" };
type AnkiCounts = { kind: "loading" } | { kind: "ready"; cards: number; words: number; pending: number; skipped: number } | { kind: "failed" };

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

// `registro-lecturas-<YYYY-MM-DD>.json`, the file name the contract fixes.
function exportFileName(now: Date, suffix = ".json"): string {
  return `registro-lecturas-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}${suffix}`;
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

export function ExportPanel() {
  const t = useTranslations("log");
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
      const { csv, cards, skipped, pending } = await buildAnkiExport();
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), exportFileName(new Date(), "-anki.csv"));
      setAnkiState({ kind: "done", cards, skipped, pending });
    } catch {
      setAnkiState({ kind: "failed" });
    }
  }

  return (
    <Flex direction="column" gap="4">
      {countState.kind === "loading" && (
        <Flex align="center" gap="2">
          <Spinner />
          <Text size="2" muted>
            {t("counting")}
          </Text>
        </Flex>
      )}

      {countState.kind === "failed" && (
        <Text size="2" muted>
          {t("countFailed")}
        </Text>
      )}

      {/* The study's own header already says the count (`study.header`);
          nothing here repeats it. An empty store has no file worth
          offering, so a confirmed zero drops the link along with it. */}
      {countState.kind !== "ready" || countState.count > 0 ? (
        <>
          {/* An underlined link, not a filled button: `/registro`'s weight is the
              study above, not this download (docs/wordbook/DESIGN.md "Settled",
              "The study replaces the download as the weight of `/registro`"). */}
          <Link asChild underline="always">
            <button type="button" onClick={() => void handleExport()} disabled={exportState.kind === "building"}>
              <TapTarget align="center" px="1">
                {exportState.kind === "building" ? t("exporting") : t("study.download")}
              </TapTarget>
            </button>
          </Link>

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

          {/* No card to give: the link is gone and its place says why
              (RL-72). Until the count is known the link does not draw; a
              failed count draws it, and the click builds and reports. */}
          {/* Words that wait are not «sin traducción guardada»: with any, the
              no-card line gives way to the waiting line and the left-out one. */}
          {ankiCounts.kind === "ready" && ankiCounts.cards === 0 && ankiCounts.pending > 0 && (
            <Flex direction="column" gap="1">
              <Text size="2" muted>
                {t("study.ankiPending", { count: ankiCounts.pending })}
              </Text>
              {ankiCounts.skipped > 0 && (
                <Text size="2" muted>
                  {t("study.ankiSkipped", { count: ankiCounts.skipped })}
                </Text>
              )}
            </Flex>
          )}

          {ankiCounts.kind === "ready" && ankiCounts.cards === 0 && ankiCounts.pending === 0 && (
            <Text size="2" muted>
              {t("study.ankiNone", { words: ankiCounts.words })}
            </Text>
          )}

          {(ankiCounts.kind === "failed" || (ankiCounts.kind === "ready" && ankiCounts.cards > 0)) && (
            <>
            <Link asChild underline="always">
              <button type="button" onClick={() => void handleAnki()} disabled={ankiState.kind === "building"}>
                <TapTarget align="center" px="1">
                  {ankiState.kind === "building" ? t("study.ankiPreparing") : t("study.downloadAnki")}
                </TapTarget>
              </button>
            </Link>

              {ankiState.kind === "done" && (
                <Flex direction="column" gap="1">
                  <Text size="2" muted>
                    {t("study.ankiDone", { cards: ankiState.cards })}
                  </Text>
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
                </Flex>
              )}
            </>
          )}

          {ankiState.kind === "failed" && (
            <Flex direction="column" gap="3" align="start">
              <Separator size="4" />
              <Text size="2" weight="bold">
                {t("study.ankiFailed")}
              </Text>
              <Button size="2" onClick={() => void handleAnki()}>
                {t("retry")}
              </Button>
            </Flex>
          )}
        </>
      ) : null}
    </Flex>
  );
}
