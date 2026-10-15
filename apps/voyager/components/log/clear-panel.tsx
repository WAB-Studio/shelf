"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { readWordStudy } from "@/lib/log/summary";
import { clearLocalLookups, countRecords } from "@/lib/log/record";
import { clearAccountLookups } from "@/lib/sync/clear";
import { Button, Flex, Link, Separator, TapTarget, Text } from "@/components/ui";

type CountState = { kind: "loading" } | { kind: "ready"; words: number; lookups: number } | { kind: "failed" };

type Stage =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "wiping"; scope: "local" | "account" }
  | { kind: "failed"; scope: "local" | "account" };

/**
 * «Vaciar el registro» (`RegistroVaciar`/`RegistroVaciarConfirmar`, approved
 * 2026-09-09): a muted counterpart to `ExportPanel`'s accent download,
 * hidden the same way once nothing is left to act on. Fetches its own count
 * on mount, the same call `HistoryList` and `ExportPanel` each make on
 * theirs — no import here reaches into a page's own IndexedDB except this
 * component's own effect (RNL-08).
 *
 * `## Failure` governs the confirm screen even though nothing failed yet:
 * no red exists in this palette, so the break reads through a hairline and
 * full-weight ink, and the accent sits on **Conservarlo**, the safe exit —
 * never on either destructive option,
 * against the usual habit of accenting the default action: a reader who
 * taps out of habit here keeps their record, never loses it.
 *
 * `hasReader` (`RegistroVaciarConfirmarSinCuenta`, approved 2026-09-10):
 * without a session the account option never draws — `/api/log/clear`
 * always answers 401 there — and the one action left reads «Vaciar el
 * registro», not «...sólo en este dispositivo», since there is no
 * alternative to contrast it with. The caller passes a boolean, never the
 * reader itself: this component has no use for an id or an email.
 */
export function ClearPanel({ hasReader }: { hasReader: boolean }) {
  const t = useTranslations("log.clear");
  const [count, setCount] = useState<CountState>({ kind: "loading" });
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([readWordStudy(), countRecords()])
      .then(([study, lookups]) => {
        if (!cancelled) setCount({ kind: "ready", words: study.total, lookups });
      })
      .catch(() => {
        if (!cancelled) setCount({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function wipeLocal(): Promise<void> {
    setStage({ kind: "wiping", scope: "local" });
    try {
      await clearLocalLookups();
      setCount({ kind: "ready", words: 0, lookups: 0 });
      setStage({ kind: "idle" });
    } catch {
      setStage({ kind: "failed", scope: "local" });
    }
  }

  // The account first, the local copy only once it confirms: a network
  // failure this way never costs a row this device had not yet agreed to
  // lose, and a retry from `failed` never repeats a local wipe that already
  // landed.
  async function wipeAccount(): Promise<void> {
    setStage({ kind: "wiping", scope: "account" });
    const ok = await clearAccountLookups();
    if (!ok) {
      setStage({ kind: "failed", scope: "account" });
      return;
    }
    try {
      await clearLocalLookups();
      setCount({ kind: "ready", words: 0, lookups: 0 });
      setStage({ kind: "idle" });
    } catch {
      setStage({ kind: "failed", scope: "account" });
    }
  }

  // Nothing to act on: `study.header` already says so, and an action that
  // would only confirm an empty store repeats it with a control that does
  // nothing (the same gate `ExportPanel` runs on the same count).
  if (count.kind !== "ready" || count.lookups === 0) return null;

  if (stage.kind === "idle") {
    return (
      <Link asChild underline="always" muted>
        <button type="button" onClick={() => setStage({ kind: "confirming" })}>
          <TapTarget size={44} align="center" px="1">
            {t("trigger")}
          </TapTarget>
        </button>
      </Link>
    );
  }

  const wiping = stage.kind === "wiping";

  return (
    // `width="100%"`: forces this item onto its own line under the row it
    // shares with `ExportPanel`'s download link (`registro/page.tsx`'s own
    // `wrap="wrap"`), instead of squeezing a multi-line confirm beside it.
    <Flex direction="column" gap="4" width="100%">
      <Separator size="4" />

      <Flex direction="column" gap="2">
        <Text variant="breakTitle">{t("confirmTitle")}</Text>
        <Text variant="breakBody" muted>
          {t("confirmBody", { words: count.words, lookups: count.lookups })}
        </Text>
      </Flex>

      <Flex>
        <Button size="3" tap={44} disabled={wiping} onClick={() => setStage({ kind: "idle" })}>
          {t("keep")}
        </Button>
      </Flex>

      {hasReader ? (
        <>
          <Flex direction="column" gap="1" align="start">
            <Link asChild underline="always" muted>
              <button type="button" disabled={wiping} onClick={() => void wipeLocal()}>
                <TapTarget size={44} align="center" px="1">
                  {stage.kind === "wiping" && stage.scope === "local" ? t("wiping") : t("localAction")}
                </TapTarget>
              </button>
            </Link>
            <Text variant="caption" muted="quietest">
              {t("localBody")}
            </Text>
            {stage.kind === "failed" && stage.scope === "local" && (
              <Flex direction="column" gap="2" align="start">
                <Text size="2" weight="bold">
                  {t("failed")}
                </Text>
                <Button size="2" tap onClick={() => void wipeLocal()}>
                  {t("retry")}
                </Button>
              </Flex>
            )}
          </Flex>

          <Flex direction="column" gap="1" align="start">
            <Link asChild underline="always" muted>
              <button type="button" disabled={wiping} onClick={() => void wipeAccount()}>
                <TapTarget size={44} align="center" px="1">
                  {stage.kind === "wiping" && stage.scope === "account" ? t("wiping") : t("accountAction")}
                </TapTarget>
              </button>
            </Link>
            <Text variant="caption" muted="quietest">
              {t("accountBody")}
            </Text>
            {stage.kind === "failed" && stage.scope === "account" && (
              <Flex direction="column" gap="2" align="start">
                <Text size="2" weight="bold">
                  {t("failed")}
                </Text>
                <Button size="2" tap onClick={() => void wipeAccount()}>
                  {t("retry")}
                </Button>
              </Flex>
            )}
          </Flex>
        </>
      ) : (
        // No account to reach without a reader: `wipeAccount` never runs
        // here, and no caption sits under the link — `confirmBody` above
        // already says what is lost (`RegistroVaciarConfirmarSinCuenta`).
        <Flex direction="column" gap="1" align="start">
          <Link asChild underline="always" muted>
            <button type="button" disabled={wiping} onClick={() => void wipeLocal()}>
              <TapTarget size={44} align="center" px="1">
                {wiping ? t("wiping") : t("soleAction")}
              </TapTarget>
            </button>
          </Link>
          {stage.kind === "failed" && (
            <Flex direction="column" gap="2" align="start">
              <Text size="2" weight="bold">
                {t("failed")}
              </Text>
              <Button size="2" tap onClick={() => void wipeLocal()}>
                {t("retry")}
              </Button>
            </Flex>
          )}
        </Flex>
      )}
    </Flex>
  );
}
