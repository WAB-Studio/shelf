"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { SETTINGS_KEYS, destinations } from "@/components/fund/destinations";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Flex, NavPanel, NavList } from "@/components/ui";
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

  return (
    <NavPanel
      open={open}
      onOpenChange={setOpen}
      title={t("settings")}
      closeLabel={t("close")}
      trigger={trigger}
    >
      <NavList items={items} onNavigate={() => setOpen(false)} />
      <Flex direction="column" gap="2">
        <LanguageSwitcher width="100%" />
        <ThemeSwitcher width="100%" />
        <SignOutButton />
      </Flex>
    </NavPanel>
  );
}
