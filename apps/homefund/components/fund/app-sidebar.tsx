"use client";

import type { LucideIcon } from "lucide-react";
import { ChevronDown, Plus, Settings } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  GROUP_SETTINGS_HREF,
  PRIMARY_KEYS,
  SIDEBAR_SECONDARY_KEYS,
  destinations,
  isCurrent,
} from "@/components/fund/destinations";
import { SettingsPanel } from "@/components/fund/settings-panel";
import { useQuickEntry } from "@/components/transactions/quick-entry-provider";
import {
  Badge,
  IconButton,
  NavList,
  type NavListItem,
  Sidebar,
  SidebarAction,
  SidebarFoot,
  SidebarHead,
  SidebarPerson,
  SidebarSeparator,
  VisuallyHidden,
} from "@/components/ui";
import { Link as LocaleLink, usePathname } from "@/i18n/navigation";

// Ajustes reaches every destination the panel lists, so the catalogue — which
// holds only what a surface offers directly — does not name it.
const SETTINGS_HREF = "/settings";

// The stroke thickens on the current destination, which is the only weight the
// row's icon carries; the pill behind it does the rest.
function icon(Icon: LucideIcon, current: boolean) {
  return <Icon size={19} strokeWidth={current ? 2 : 1.8} />;
}

/**
 * The desktop shell (`private/design-desktop/SPEC-A3.md`): every primary screen one
 * click away from every other, Ajustes among them, and quick entry (RF-22)
 * without leaving the screen. The person's own row keeps the settings panel, which
 * is their menu and not an index of destinations. Below `md` it does not render —
 * the bottom bar owns navigation there.
 */
export function AppSidebar({
  fundName,
  hasGroup,
  personName,
  role,
  pendingCount,
}: {
  fundName: string;
  hasGroup: boolean;
  personName: string;
  role: "leader" | "member" | null;
  pendingCount: number;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { openQuick } = useQuickEntry();

  // The queue's waiting count, spoken rather than left as a bare number.
  const pendingBadge = pendingCount > 0 && (
    <Badge color="amber" variant="soft" radius="full">
      <span aria-hidden>{pendingCount}</span>
      <VisuallyHidden>{t("pending", { count: pendingCount })}</VisuallyHidden>
    </Badge>
  );

  // Ajustes is a screen of its own on a laptop, so its row is a destination like
  // the ones above it. Every settings path opens with the same segment, so only
  // an exact match lights this row and not Cuentas or Datos.
  const settings: NavListItem = {
    key: "settings",
    href: SETTINGS_HREF,
    icon: icon(Settings, pathname === SETTINGS_HREF),
    label: t("settings"),
    current: pathname === SETTINGS_HREF,
  };

  function items(keys: Parameters<typeof destinations>[0]): NavListItem[] {
    return destinations(keys, hasGroup).map(({ key, href, icon: Icon }) => {
      const current = isCurrent(pathname, href);
      return {
        key,
        href,
        icon: icon(Icon, current),
        label: t(key),
        current,
        badge: key === "inbox" ? pendingBadge || undefined : undefined,
      };
    });
  }

  return (
    <Sidebar label={t("title")} display={{ initial: "none", md: "flex" }}>
      <SidebarHead
        title={fundName}
        action={
          // `/settings/group` refuses a caller without one, so the chevron drops
          // with it: the list already drops Miembros the same way.
          hasGroup && (
            <IconButton
              asChild
              tap
              size="1"
              variant="ghost"
              color="gray"
              aria-label={t("fundSettings")}
            >
              <LocaleLink href={GROUP_SETTINGS_HREF}>
                <ChevronDown size={16} strokeWidth={2} />
              </LocaleLink>
            </IconButton>
          )
        }
      />

      <NavList variant="sidebar" items={items(PRIMARY_KEYS)} />
      <SidebarSeparator />
      <NavList
        variant="sidebar"
        items={[...items(SIDEBAR_SECONDARY_KEYS), settings]}
      />

      <SidebarFoot>
        <SidebarAction
          icon={<Plus size={18} strokeWidth={2.2} />}
          label={t("record")}
          onClick={openQuick}
        />
        {/* The whole row is the trigger, so the panel behind Ajustes is also a
            click away from the person it belongs to. */}
        <SettingsPanel
          hasGroup={hasGroup}
          trigger={
            <SidebarPerson
              name={personName}
              role={
                role
                  ? t(role === "leader" ? "roleLeader" : "roleMember")
                  : undefined
              }
            />
          }
        />
      </SidebarFoot>
    </Sidebar>
  );
}
