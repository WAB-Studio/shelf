import type { LucideIcon } from "lucide-react";
import {
  ArrowRightLeft,
  CalendarDays,
  ChartColumnBig,
  ChartLine,
  CreditCard,
  Database,
  House,
  Inbox,
  Repeat,
  ScrollText,
  Tag,
  Tags,
  Target,
  Users,
  Wallet,
  Webhook,
} from "lucide-react";

/**
 * Every destination the shell can reach, written once. Each surface below picks
 * an order out of it; none of them owns a path or an icon. A screen shipped
 * without an entry here is a screen no surface offers, which is how `/movements`
 * and `/reports` stayed unreachable on a laptop.
 *
 * The key is also its own message key under the `nav` namespace.
 */
const CATALOGUE = {
  home: { href: "/", icon: House },
  movements: { href: "/movements", icon: ArrowRightLeft },
  planning: { href: "/planning", icon: Target },
  budgets: { href: "/planning/budgets", icon: ChartColumnBig },
  goals: { href: "/planning/goals", icon: Target },
  payments: { href: "/planning/payments", icon: CalendarDays },
  recurring: { href: "/planning/recurring", icon: Repeat },
  debts: { href: "/planning/debts", icon: CreditCard },
  reports: { href: "/reports", icon: ChartLine },
  inbox: { href: "/inbox", icon: Inbox },
  members: { href: "/settings/members", icon: Users },
  accounts: { href: "/settings/accounts", icon: Wallet },
  categories: { href: "/settings/categories", icon: Tags },
  labels: { href: "/settings/labels", icon: Tag },
  webhooks: { href: "/settings/webhooks", icon: Webhook },
  data: { href: "/settings/data", icon: Database },
  audit: { href: "/settings/audit", icon: ScrollText },
} as const satisfies Record<string, { href: string; icon: LucideIcon }>;

export type DestinationKey = keyof typeof CATALOGUE;

export type Destination = {
  key: DestinationKey;
  href: string;
  icon: LucideIcon;
};

// The phone's bottom bar: the frequent three, around the raised action.
export const TAB_KEYS = ["home", "movements", "planning"] as const;

// The sidebar's own list, in the order `private/design-desktop/SPEC-A3.md` fixes.
// Planeación opens in place: a laptop has the height to offer its five screens
// directly, so the hub behind the phone's tab is not a stop on the way here.
export const PRIMARY_KEYS = [
  "home",
  "movements",
  "budgets",
  "goals",
  "payments",
  "recurring",
  "debts",
  "reports",
  "inbox",
] as const;

// Planeación's own five, in the order the sidebar and `PlanningSubNav`'s chips
// both keep. The hub reads this list only for each area's `href` and `icon`;
// it orders its own cards separately.
export const PLANNING_KEYS = [
  "budgets",
  "goals",
  "payments",
  "recurring",
  "debts",
] as const;

// What the sidebar keeps below its separator, beside the settings panel's trigger.
// Auditoría and Webhooks stay out of it: both are rare and stay in the panel.
export const SIDEBAR_SECONDARY_KEYS = [
  "accounts",
  "members",
  "categories",
  "labels",
  "data",
] as const;

// The settings panel, the only surface that reaches the rest of the app.
export const SETTINGS_KEYS = [
  "inbox",
  "members",
  "accounts",
  "categories",
  "labels",
  "webhooks",
  "data",
  "audit",
] as const;

/**
 * The fund's own settings sit outside the catalogue: the chevron beside the fund
 * name is what reaches them, and the settings panel owns the list of every other
 * destination. No surface lists this one, so no surface can offer it twice.
 */
export const GROUP_SETTINGS_HREF = "/settings/group";

// One group per user with no switching (RF-55), so every destination is a fixed
// path. Members only exist inside a group, so that entry drops without one.
export function destinations(
  keys: readonly DestinationKey[],
  hasGroup: boolean,
): Destination[] {
  return keys
    .filter((key) => key !== "members" || hasGroup)
    .map((key) => ({ key, ...CATALOGUE[key] }));
}

// A movement's detail page still lights Movimientos; only the root matches itself.
export function isCurrent(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
