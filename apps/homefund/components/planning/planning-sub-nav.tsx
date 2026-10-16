"use client";

import { useTranslations } from "next-intl";

import { PLANNING_KEYS, destinations, isCurrent } from "@/components/fund/destinations";
import { SubNav } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

/**
 * The five chips a laptop offers to jump between Planeación's own screens
 * (RF-71, RF-74, RF-76, RF-29, RF-83), now that the sidebar reaches each of
 * them directly and the hub is no longer the only way in. `/planning/debts/{id}`
 * still marks Deudas: `isCurrent` matches on the prefix, not the exact path.
 */
export function PlanningSubNav() {
  const t = useTranslations("nav");
  const tPlanning = useTranslations("planning");
  const pathname = usePathname();

  // Planeación has no member-only entry, so the group flag never filters here.
  const items = destinations(PLANNING_KEYS, true).map(({ key, href }) => ({
    key,
    href,
    label: t(key),
    current: isCurrent(pathname, href),
  }));

  return <SubNav label={tPlanning("nav")} items={items} />;
}
