"use client";

import { useTranslations } from "next-intl";

import { Button, Flex, Heading, Link, Page, TapTarget } from "@/components/ui";
import { Link as LocaleLink } from "@/i18n/navigation";

/**
 * The signed-in shell's boundary. It replaces the screen and nothing else — the
 * layout above it survives, so the header and the tab bar stay on and every
 * destination is still one tap away. Neither `error.message` nor `error.digest`
 * reaches the screen: a server component's message is an internal, and the digest
 * is a handle for the server's own log, not something a person acts on. From
 * `md` up the same message, retry and way home sit on the artboard's centred
 * card instead of loose on the page.
 */
export default function AppError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations();

  return (
    <Page>
      <Flex
        display={{ initial: "flex", md: "none" }}
        direction="column"
        align="center"
        justify="center"
        gap="4"
        flexGrow="1"
      >
        <Heading size="6" align="center">
          {t("errors.unexpected")}
        </Heading>
        <Button size="3" onClick={() => retry()}>
          {t("common.retry")}
        </Button>
        <Link asChild>
          <LocaleLink href="/">
            <TapTarget align="center" justify="center" px="2">
              {t("common.backHome")}
            </TapTarget>
          </LocaleLink>
        </Link>
      </Flex>

      <Flex
        display={{ initial: "none", md: "flex" }}
        align="center"
        justify="center"
        flexGrow="1"
      >
        <Flex
          direction="column"
          align="center"
          gap="4"
          style={{
            width: 560,
            backgroundColor: "var(--color-panel-solid)",
            border: "1px solid var(--gray-a4)",
            borderRadius: 16,
            padding: "34px 32px",
          }}
        >
          <Heading size="6" align="center">
            {t("errors.unexpected")}
          </Heading>
          <Button size="3" onClick={() => retry()}>
            {t("common.retry")}
          </Button>
          <Link asChild>
            <LocaleLink href="/">
              <TapTarget align="center" justify="center" px="2">
                {t("common.backHome")}
              </TapTarget>
            </LocaleLink>
          </Link>
        </Flex>
      </Flex>
    </Page>
  );
}
