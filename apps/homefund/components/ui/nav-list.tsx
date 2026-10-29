import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";
import { Flex, Link } from "@radix-ui/themes";

import { Link as LocaleLink } from "@/i18n/navigation";
import { TapTarget } from "./tap-target";
import styles from "./nav-list.module.css";

export type NavListItem = {
  key: string;
  href: string;
  icon: ReactNode;
  label: ReactNode;
  current: boolean;
  // Rides at the row's end. The sidebar variant alone has room for one.
  badge?: ReactNode;
};

/**
 * The one list every navigation surface renders. `panel` is the sheet's plain
 * stack of links; `sidebar` is the pill row of `private/design-desktop/SPEC-A3.md`,
 * whose active state fills. State never lives here — a caller decides which row
 * is current and what a click does.
 */
export function NavList({
  items,
  variant = "panel",
  onNavigate,
}: {
  items: NavListItem[];
  variant?: "panel" | "sidebar";
  onNavigate?: () => void;
}) {
  if (variant === "sidebar") {
    return (
      <Flex direction="column" style={{ gap: 2 }}>
        {items.map((item) => (
          <LocaleLink
            key={item.key}
            href={item.href}
            className={styles.row}
            data-current={item.current || undefined}
            aria-current={item.current ? "page" : undefined}
            onClick={onNavigate}
          >
            {item.icon}
            <span className={styles.label}>{item.label}</span>
            {item.badge && <span className={styles.badge}>{item.badge}</span>}
          </LocaleLink>
        ))}
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="1">
      {items.map((item) => (
        <Link
          key={item.key}
          asChild
          color={item.current ? undefined : "gray"}
          weight={item.current ? "bold" : undefined}
          highContrast={item.current}
        >
          <LocaleLink
            href={item.href}
            aria-current={item.current ? "page" : undefined}
            onClick={onNavigate}
          >
            <TapTarget align="center" gap="2">
              {item.icon}
              {item.label}
            </TapTarget>
          </LocaleLink>
        </Link>
      ))}
    </Flex>
  );
}

// A sidebar row that opens something instead of going somewhere. It forwards the
// ref and the props a trigger clones onto it (asChild), so a NavPanel can drive
// it directly, and it wears the same pill as the rows above it.
export const NavListTrigger = forwardRef<
  HTMLButtonElement,
  { icon: ReactNode; label: ReactNode } & ComponentPropsWithoutRef<"button">
>(function NavListTrigger({ icon, label, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.row} ${styles.trigger}`}
      {...props}
    >
      {icon}
      <span className={styles.label}>{label}</span>
    </button>
  );
});
