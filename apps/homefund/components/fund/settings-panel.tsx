"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { FUND_SETTINGS, SETTINGS_KEYS, destinations } from "@/components/fund/destinations";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Box, Flex, NavPanel, NavList, type NavListItem, Text } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

/**
 * The secondary destinations and the preferences, behind one trigger. Both the
 * bottom bar and the sidebar open this same panel, so a destination reaches
 * every viewport the moment it enters the catalogue (RNF-08).
 */
export function SettingsPanel({
  hasGroup,
  trigger,
}: {
  hasGroup: boolean;
  trigger: ReactNode;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [renderedPathname, setRenderedPathname] = useState(pathname);

  // Closes the panel on any navigation, the browser back gesture included.
  if (pathname !== renderedPathname) {
    setRenderedPathname(pathname);
    setOpen(false);
  }

  const items = destinations(SETTINGS_KEYS, hasGroup).map(
    ({ key, href, icon: Icon }) => ({
      key,
      href,
      icon: <Icon size={18} />,
      label: t(key),
      current: pathname === href,
    }),
  );

  // Planeación left the phone's bar for Bandeja, so the panel leads with it.
  const planningItems = destinations(["planning"], hasGroup).map(
    ({ key, href, icon: Icon }) => ({
      key,
      href,
      icon: <Icon size={18} />,
      label: t(key),
      current: pathname.startsWith(href),
    }),
  );

  // The phone has no rail; from `sm` up the chevron beside the fund name owns this row.
  const fundItems: NavListItem[] = hasGroup
    ? [
        {
          key: FUND_SETTINGS.key,
          href: FUND_SETTINGS.href,
          icon: <FUND_SETTINGS.icon size={18} />,
          label: <Text weight="bold">{t(FUND_SETTINGS.key)}</Text>,
          current: pathname === FUND_SETTINGS.href,
        },
      ]
    : [];

  return (
    <NavPanel
      open={open}
      onOpenChange={setOpen}
      title={t("settings")}
      closeLabel={t("close")}
      trigger={trigger}
    >
      {fundItems.length > 0 && (
        <Box display={{ initial: "block", sm: "none" }}>
          <NavList items={fundItems} onNavigate={() => setOpen(false)} />
        </Box>
      )}
      <Box display={{ initial: "block", sm: "none" }}>
        <NavList items={planningItems} onNavigate={() => setOpen(false)} />
      </Box>
      <NavList items={items} onNavigate={() => setOpen(false)} />
      <Flex direction="column" gap="2">
        <LanguageSwitcher width="100%" showText />
        <ThemeSwitcher width="100%" showText />
        <SignOutButton />
      </Flex>
    </NavPanel>
  );
}
