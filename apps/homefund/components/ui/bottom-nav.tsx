import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";

import { Flex, Link, Text } from "@radix-ui/themes";

import { Link as LocaleLink } from "@/i18n/navigation";
import { TapTarget } from "./tap-target";
import styles from "./bottom-nav.module.css";

export type BottomNavTab = {
  key: string;
  icon: ReactNode;
  label: ReactNode;
  href?: string;
  active?: boolean;
  disabled?: boolean;
};

// A tab renders its icon over its label. A live tab is a link; a disabled one is
// inert text the pointer cannot reach, muted so it reads as "coming later".
function Tab({ tab }: { tab: BottomNavTab }) {
  const body = (
    <Flex direction="column" align="center" gap="1">
      {tab.icon}
      <Text size="1" weight={tab.active ? "bold" : "medium"}>
        {tab.label}
      </Text>
    </Flex>
  );

  if (!tab.href || tab.disabled) {
    return (
      <Text as="span" color="gray" aria-disabled={tab.disabled}>
        {body}
      </Text>
    );
  }

  return (
    <Link
      asChild
      color={tab.active ? undefined : "gray"}
      highContrast={tab.active}
    >
      <LocaleLink
        href={tab.href}
        aria-current={tab.active ? "page" : undefined}
      >
        <TapTarget align="center" justify="center">
          {body}
        </TapTarget>
      </LocaleLink>
    </Link>
  );
}

// The "more" slot as a button that reads like a tab. It forwards the ref and the
// props a trigger clones onto it (asChild), so a NavPanel can drive it directly.
export const BottomNavTrigger = forwardRef<
  HTMLButtonElement,
  { icon: ReactNode; label: ReactNode } & ComponentPropsWithoutRef<"button">
>(function BottomNavTrigger({ icon, label, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={styles.trigger} {...props}>
      <TapTarget align="center" justify="center">
        <Flex direction="column" align="center" gap="1">
          {icon}
          <Text size="1" weight="medium" color="gray">
            {label}
          </Text>
        </Flex>
      </TapTarget>
    </button>
  );
});

/**
 * The mobile bottom bar (`docs/DESIGN.md`, Navigation): a fixed row of tabs with
 * a raised action at its center. Purely presentational — every tab's state, the
 * center node and the trailing "more" trigger arrive as props. The tabs split
 * around the center so it lands in the middle whatever the count.
 */
export function BottomNav({
  tabs,
  centerAction,
  moreTrigger,
}: {
  tabs: BottomNavTab[];
  centerAction: ReactNode;
  moreTrigger: ReactNode;
}) {
  const split = Math.ceil(tabs.length / 2);
  const before = tabs.slice(0, split);
  const after = tabs.slice(split);

  return (
    <Flex asChild align="center" justify="between" className={styles.bar}>
      <nav>
        {before.map((tab) => (
          <Tab key={tab.key} tab={tab} />
        ))}
        <Flex align="center" justify="center" className={styles.center}>
          {centerAction}
        </Flex>
        {after.map((tab) => (
          <Tab key={tab.key} tab={tab} />
        ))}
        {moreTrigger}
      </nav>
    </Flex>
  );
}
