"use client";

import { useTranslations } from "next-intl";

import { Button, Flex, Headword, Page, Separator } from "@/components/ui";

// docs/wordbook/DESIGN.md "Settled": the shell stays put on a crash. `Page`
// mounts its own `BottomNav` (bar on mobile, sidebar from 1024px), so this
// fallback carries it fresh the same way every other screen does — nothing
// above `app/layout.tsx` ever unmounts, so the reader can still leave for
// another section without reloading.
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("error");

  return (
    <Page>
      <Flex direction="column" gap="4" align="center" justify="center" flexGrow="1">
        {/* docs/wordbook/DESIGN.md "Failure": the hairline sets the break off,
            the title stays full-weight ink, the accent lives in retry alone. */}
        <Separator size="4" />
        <Headword align="center">{t("title")}</Headword>
        <Button size="2" onClick={reset}>
          {t("retry")}
        </Button>
      </Flex>
    </Page>
  );
}
