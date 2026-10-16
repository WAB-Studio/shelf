"use client";

import { useTranslations } from "next-intl";

import type { InstallFailure, InstallProgress } from "@/lib/dictionary/install";
import { Button, Flex, Live, Progress, Separator, Spinner, Text } from "@/components/ui";

// Structural, not imported: the worker's own status type only has to satisfy
// this shape, so this file never depends on the module that produces it
// (RL-12).
export type InstallStatusValue = {
  state: "booting" | "installing" | "ready" | "failed";
  progress?: InstallProgress;
  reason?: InstallFailure;
};

// Sits beside the search box, never in its place: `null` when there is
// nothing to say, and no branch here ever disables an input or steals focus
// (RL-12, RL-13).
export function InstallStatus({
  status,
  onRetry,
  query,
  hasBox = true,
}: {
  status: InstallStatusValue;
  onRetry: () => void;
  // What the box holds right now — read only to say what will happen to it.
  // Nothing here re-sends a query: the worker's own queue is what answers
  // it once the install lands (`use-dictionary.ts`).
  query: string;
  // False on a screen that shows no search box of its own
  // (`word-history.tsx`): "keep searching meanwhile" names a control that
  // screen never has.
  hasBox?: boolean;
}) {
  const t = useTranslations("install");
  const tLive = useTranslations("live");
  const typed = query.trim().length > 0;
  const pending = typed && (
    <Text size="2" muted>
      {t("pending", { query })}
    </Text>
  );

  // Mounted in every state so a change lands in a region already there.
  // The percent is left out: it would speak on every tick.
  const live = (
    <>
      <Live>{status.state === "installing" ? tLive("installing") : ""}</Live>
      <Live assertive>{status.state === "failed" ? tLive("installFailed") : ""}</Live>
    </>
  );

  if (status.state === "ready") {
    return live;
  }

  if (status.state === "booting") {
    return (
      <Flex direction="column" gap="1">
        {live}
        <Flex align="center" gap="2">
          <Spinner />
          <Text size="2" muted>
            {hasBox ? t("preparing") : t("preparingReadOnly")}
          </Text>
        </Flex>
        {pending}
      </Flex>
    );
  }

  if (status.state === "installing") {
    // A `content-length`-less response means an indeterminate bar: RL-12
    // only promises that progress is shown, not a number that does not exist.
    if (!status.progress || status.progress.total === null) {
      return (
        <Flex direction="column" gap="1">
          {live}
          <Progress aria-label={t("progressLabel")} />
          <Text size="2" muted>
            {t("unknownSize")}
          </Text>
          {pending}
        </Flex>
      );
    }

    const { received, total } = status.progress;
    // `received` and `total` are both decoded bytes (`install.ts`), so this
    // reaches exactly 100 the instant the transfer completes — never before,
    // never short of it — whatever the wire's own compression ratio was.
    const percent = Math.min(100, Math.round((received / total) * 100));
    return (
      <Flex direction="column" gap="1">
        {live}
        <Progress value={percent} aria-label={t("progressLabel")} />
        <Text size="2" muted>
          {t("progress", { percent })}
        </Text>
        {pending}
      </Flex>
    );
  }

  // No red in this palette (docs/wordbook/DESIGN.md "Failure"): a hairline
  // sets the break off, full-weight ink says it, the accent lives in retry.
  return (
    <Flex direction="column" gap="3" align="start">
      {live}
      <Separator size="4" />
      <Text size="2" weight="bold">
        {t("failed")}
      </Text>
      {typed && (
        <Text size="2" muted>
          {t("failedPending", { query })}
        </Text>
      )}
      <Button size="2" onClick={onRetry}>
        {t("retry")}
      </Button>
    </Flex>
  );
}
