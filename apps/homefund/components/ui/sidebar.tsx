import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";
import { ChevronRight } from "lucide-react";
import {
  Avatar,
  Button,
  Flex,
  type FlexProps,
  Separator,
  Text,
} from "@radix-ui/themes";

import styles from "./sidebar.module.css";

/**
 * The desktop shell's left column (`private/design-desktop/SPEC-A3.md`): 248px of
 * surface against the page, sticky so its foot stays reachable however long the
 * screen beside it runs. Its first child is the head and its last is the foot:
 * those two stay pinned and everything between them scrolls, which is what keeps
 * Registrar and the person row on a 720p laptop. `display` is the caller's,
 * because the bottom bar owns navigation below `md` and this must not render
 * there.
 */
export function Sidebar({
  label,
  display,
  children,
}: {
  label: string;
  display?: FlexProps["display"];
  children?: ReactNode;
}) {
  return (
    <Flex asChild direction="column" display={display} className={styles.sidebar}>
      <nav aria-label={label}>{children}</nav>
    </Flex>
  );
}

// The rule between the sidebar's two groups of destinations, inset from the rows.
export function SidebarSeparator() {
  return <Separator size="4" className={styles.separator} />;
}

// The head of SPEC-A3: the active fund named, and beside it whatever reaches the
// fund itself.
export function SidebarHead({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <Flex align="center" className={styles.head}>
      <Text truncate className={styles.fund}>
        {title}
      </Text>
      {action}
    </Flex>
  );
}

// The foot the column pins: the primary action over the person's row.
export function SidebarFoot({ children }: { children?: ReactNode }) {
  return (
    <Flex direction="column" className={styles.foot}>
      {children}
    </Flex>
  );
}

// Registrar (SPEC-A3): the sidebar's one primary action, sized from the foot it
// fills rather than from Radix's control scale.
export function SidebarAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button type="button" size="3" onClick={onClick} className={styles.action}>
      {icon}
      {label}
    </Button>
  );
}

/**
 * The person's row at the foot: who is signed in, over the role they hold. It
 * opens something rather than going somewhere, so it forwards the ref and the
 * props a trigger clones onto it (asChild).
 */
export const SidebarPerson = forwardRef<
  HTMLButtonElement,
  { name: string; role?: string } & Omit<
    ComponentPropsWithoutRef<typeof Button>,
    "children"
  >
>(function SidebarPerson({ name, role, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      color="gray"
      highContrast
      {...props}
      className={className ? `${styles.person} ${className}` : styles.person}
    >
      {/* The initial repeats the name beside it; a reader announces the row once. */}
      <Avatar
        aria-hidden
        size="1"
        radius="full"
        fallback={name.slice(0, 1).toUpperCase()}
        className={styles.avatar}
      />
      {/* `align="start"` would let each Text keep its own content width instead of
          the column's, so a long one spills past the chevron and the sidebar's
          edge rather than truncating: stretch (the default) hands both Texts the
          column's own, already-shrunk, width. */}
      <Flex direction="column" minWidth="0" flexGrow="1">
        <Text truncate className={styles.name}>
          {name}
        </Text>
        {role && (
          <Text color="gray" truncate className={styles.role}>
            {role}
          </Text>
        )}
      </Flex>
      <ChevronRight size={16} strokeWidth={2} className={styles.chevron} />
    </Button>
  );
});
