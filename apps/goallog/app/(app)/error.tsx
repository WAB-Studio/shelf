"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Button, Page, ScreenExit, ScreenHeader } from "@/components/ui";

/**
 * `ArmazonFallo.dc.html` (RNP-01, RNP-16). `app/(app)/layout.tsx` still renders above this
 * boundary — `node_modules/next/dist/docs/.../file-conventions/error.md`:
 * an `error.js` wraps its own segment's children, never the layout that owns
 * it — so the nav that layout already draws keeps drawing here, with
 * whatever tab the crashed path itself carries; no second one is written by
 * hand. The header carries no way back: the two actions below are the exit.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const t = useTranslations("common.error");

  return (
    <Page width="full">
      <ScreenHeader title={t("title")} />
      <ScreenExit message={t("body")}>
        <Button onClick={() => retry()}>{t("retry")}</Button>
        <Button asChild variant="ghost" tone="accent">
          <Link href="/">{t("secondaryAction")}</Link>
        </Button>
      </ScreenExit>
    </Page>
  );
}
