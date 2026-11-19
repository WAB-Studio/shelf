"use client";

import type { ComponentPropsWithoutRef } from "react";
import { DropdownMenu } from "@radix-ui/themes";

import styles from "./menu.module.css";

type ItemProps = ComponentPropsWithoutRef<typeof DropdownMenu.Item>;
type LabelProps = ComponentPropsWithoutRef<typeof DropdownMenu.Label>;

function join(base: string, className: string | undefined): string {
  return className ? `${base} ${className}` : base;
}

// A menu of actions: Radix Themes' dropdown, its items grown to 44px under a thumb and its
// notes (a line that explains, not an action) allowed to wrap.
function Item({ className, ...props }: ItemProps) {
  return <DropdownMenu.Item {...props} className={join(styles.item, className)} />;
}

function Note({ className, ...props }: LabelProps) {
  return <DropdownMenu.Label {...props} className={join(styles.note, className)} />;
}

export const Menu = {
  Root: DropdownMenu.Root,
  Trigger: DropdownMenu.Trigger,
  Content: DropdownMenu.Content,
  Separator: DropdownMenu.Separator,
  Item,
  Note,
};
