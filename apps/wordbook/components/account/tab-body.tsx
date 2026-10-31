"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import NextLink from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { Card, Flex, Link, TapTarget, Text } from "@/components/ui";

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
        <NextLink href="/cuenta?tab=info" prefetch={false} aria-current={info ? "page" : undefined}>
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

const TWO_PANELS = "(min-width: 1280px)";

function subscribeToWidth(onChange: () => void): () => void {
  const query = window.matchMedia(TWO_PANELS);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

// The second panel from 1280px: the credits stand beside the account tab, and the panel stays empty
// on the information tab, which already shows them, so the layout does not move between tabs. Drawn
// only where it shows, so a narrower screen holds no second copy of the credits.
export function InfoSide({ info }: { info: ReactNode }) {
  const wide = useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(TWO_PANELS).matches,
    () => false,
  );
  const infoTab = useInfoTab();
  return wide && !infoTab ? <Card>{info}</Card> : null;
}
