import { getTranslations } from "next-intl/server";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { SETTINGS_KEYS, destinations } from "@/components/fund/destinations";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import {
  Box,
  Card,
  Flex,
  NavList,
  type NavListItem,
  ScreenHeader,
} from "@/components/ui";

/**
 * Ajustes as a screen, which is the only shape a laptop has for it: the bottom
 * bar's sheet is a phone surface and the sidebar has no room for these eight.
 * It reads the same catalogue the sheet reads, so a destination entered there
 * arrives here without an edit, and it holds the sheet's own language, theme and
 * sign-out controls (RF-46, RF-47, RF-54).
 *
 * The fund's settings stay out of it: the chevron beside the fund name reaches
 * them, and no surface offers a destination twice.
 */
export async function SettingsScreen({ hasGroup }: { hasGroup: boolean }) {
  const t = await getTranslations("nav");

  // Every destination named here sits below this route, so no row of the list is
  // ever the current one.
  const items: NavListItem[] = destinations(SETTINGS_KEYS, hasGroup).map(
    ({ key, href, icon: Icon }) => ({
      key,
      href,
      icon: <Icon size={19} strokeWidth={1.8} />,
      label: t(key),
      current: false,
    }),
  );

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader title={t("settings")} />

      {/* The gutter the header and the cards carry from `md` up, where the page
          hands it over; below it the page's own padding still holds. */}
      <Flex direction="column" gap="4" px={{ initial: "0", md: "6" }}>
        {/* One list, two shapes: the sidebar's pill rows on a laptop, the sheet's
            stack on a phone. Exactly one is displayed at any width. */}
        <Box display={{ initial: "none", md: "block" }}>
          <Card size="2">
            <NavList variant="sidebar" items={items} />
          </Card>
        </Box>
        <Box display={{ initial: "block", md: "none" }}>
          <NavList items={items} />
        </Box>

        <Card size="2">
          <Flex
            direction={{ initial: "column", md: "row" }}
            align={{ initial: "stretch", md: "center" }}
            gap="3"
          >
            <LanguageSwitcher width={{ initial: "100%", md: "11rem" }} />
            <ThemeSwitcher width={{ initial: "100%", md: "11rem" }} />
            <SignOutButton />
          </Flex>
        </Card>
      </Flex>
    </Flex>
  );
}
