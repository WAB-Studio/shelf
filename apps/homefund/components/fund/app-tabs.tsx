"use client";

import { Plus, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

import { TAB_KEYS, destinations, isCurrent } from "@/components/fund/destinations";
import { SettingsPanel } from "@/components/fund/settings-panel";
import { useMovementEntry } from "@/components/transactions/movement-entry-provider";
import {
  BottomNav,
  type BottomNavTab,
  BottomNavTrigger,
  IconButton,
} from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

export function AppTabs({
  hasGroup,
  inboxCount,
  keepSignedIn,
}: {
  hasGroup: boolean;
  inboxCount: number;
  keepSignedIn: string;
}) {
  const t = useTranslations("nav");
  const { openForm } = useMovementEntry();
  const pathname = usePathname();

  const tabs: BottomNavTab[] = destinations(TAB_KEYS, hasGroup).map(
    ({ key, href, icon: Icon }) => ({
      key,
      href,
      active: isCurrent(pathname, href),
      icon: <Icon size={22} />,
      label: t(key),
      // Bandeja's waiting count, hidden at zero; the name speaks it too.
      badge:
        key === "inbox" && inboxCount > 0
          ? { count: inboxCount, label: `${t(key)}, ${t("pending", { count: inboxCount })}` }
          : undefined,
    }),
  );

  // The raised action opens the movement form in place (RF-272): one tap, no route change.
  const centerAction = (
    <IconButton
      type="button"
      size="4"
      radius="full"
      aria-label={t("quickEntry")}
      onClick={openForm}
    >
      <Plus size={26} />
    </IconButton>
  );

  const moreTrigger = (
    <SettingsPanel
      hasGroup={hasGroup}
      keepSignedIn={keepSignedIn}
      trigger={
        <BottomNavTrigger
          icon={<SlidersHorizontal size={22} />}
          label={t("settings")}
        />
      }
    />
  );

  return (
    <BottomNav tabs={tabs} centerAction={centerAction} moreTrigger={moreTrigger} />
  );
}
