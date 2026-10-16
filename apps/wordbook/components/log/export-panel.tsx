"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { buildExport } from "@/lib/log/export";
import { countRecords, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { Flex, Link, Spinner, TapTarget, Text } from "@/components/ui";

type CountState = { kind: "loading" } | { kind: "ready"; count: number } | { kind: "failed" };
type ExportState = { kind: "idle" } | { kind: "building" } | { kind: "done" } | { kind: "failed" };

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

// `registro-lecturas-<YYYY-MM-DD>.json`, the file name the contract fixes.
function exportFileName(now: Date): string {
  return `registro-lecturas-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
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
    }

    count();
    // A clear or a flush changes what this panel offers to download without
    // reloading the page: `LOG_CLEARED_EVENT` can drop the count to zero,
    // which hides the link (`history-list.tsx` rereads its own list the
    // same way).
    window.addEventListener(LOG_CLEARED_EVENT, count);
    window.addEventListener(LOG_FLUSHED_EVENT, count);
    return () => {
      cancelled = true;
      window.removeEventListener(LOG_CLEARED_EVENT, count);
      window.removeEventListener(LOG_FLUSHED_EVENT, count);
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
              study above, not this download (docs/voyager/DESIGN.md "Settled",
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
        </>
      ) : null}
    </Flex>
  );
}
