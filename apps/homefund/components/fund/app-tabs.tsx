"use client";

import { Plus, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

import { TAB_KEYS, destinations, isCurrent } from "@/components/fund/destinations";
import { SettingsPanel } from "@/components/fund/settings-panel";
import { useQuickEntry } from "@/components/transactions/quick-entry-provider";
import {
  BottomNav,
  type BottomNavTab,
  BottomNavTrigger,
  IconButton,
} from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

export function AppTabs({ hasGroup }: { hasGroup: boolean }) {
  const t = useTranslations("nav");
  const { openQuick } = useQuickEntry();
  const pathname = usePathname();

  const tabs: BottomNavTab[] = destinations(TAB_KEYS, hasGroup).map(
    ({ key, href, icon: Icon }) => ({
      key,
      href,
      active: isCurrent(pathname, href),
      icon: <Icon size={22} />,
      label: t(key),
    }),
  );

  // The raised action opens the expense quick sheet in place (RF-22): one tap, no
  // route change. Income and transfer live behind the sheet's link.
  const centerAction = (
    <IconButton
      type="button"
      size="4"
      radius="full"
      aria-label={t("quickEntry")}
      onClick={openQuick}
    >
      <Plus size={26} />
    </IconButton>
  );

  const moreTrigger = (
    <SettingsPanel
      hasGroup={hasGroup}
      trigger={
        <BottomNavTrigger icon={<SlidersHorizontal size={22} />} label={t("settings")} />
      }
    />
  );

  return (
    <BottomNav tabs={tabs} centerAction={centerAction} moreTrigger={moreTrigger} />
  );
}
