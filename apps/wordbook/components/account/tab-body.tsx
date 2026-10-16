"use client";

import type { ReactNode } from "react";
import NextLink from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { Flex, Link, TapTarget, Text } from "@/components/ui";

// The tab is read from the address on the client: a cached copy of /cuenta
// answers every `?tab=`, and the server's own choice would hydrate as the
// account tab (RL-61).
function useInfoTab(): boolean {
  return useSearchParams().get("tab") === "info";
}

// Two tabs, `?tab=` on the same route — the box's own `/?q=` pattern
// (search-screen.tsx), so the licence tab is a link, not a control, and reads
// the same signed out as signed in (RL-33).
export function AccountTabs() {
  const t = useTranslations("account.info");
  const info = useInfoTab();
  return (
    <Flex gap="5">
      <Link asChild underline="none">
        <NextLink href="/cuenta" aria-current={info ? undefined : "page"}>
          <TapTarget>
            <Text size="2" weight={info ? undefined : "bold"} muted={info}>
              {t("tabs.account")}
            </Text>
          </TapTarget>
        </NextLink>
      </Link>
      <Link asChild underline="none">
        <NextLink href="/cuenta?tab=info" aria-current={info ? "page" : undefined}>
          <TapTarget>
            <Text size="2" weight={info ? "bold" : undefined} muted={!info}>
              {t("tabs.info")}
            </Text>
          </TapTarget>
        </NextLink>
      </Link>
    </Flex>
  );
}

export function TabBody({ account, info }: { account: ReactNode; info: ReactNode }) {
  return useInfoTab() ? info : account;
}
