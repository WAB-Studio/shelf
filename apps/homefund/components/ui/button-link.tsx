"use client";

import type { ComponentProps } from "react";
import type { ButtonProps } from "@radix-ui/themes";

import { Link as LocaleLink } from "@/i18n/navigation";

import { Button } from "./button";

type ButtonLinkProps = Omit<ButtonProps, "asChild" | "children"> & {
  href: ComponentProps<typeof LocaleLink>["href"];
  children: React.ReactNode;
};

// A button that navigates. A server component must use this, never
// `<Button asChild><LocaleLink/></Button>`: across the server boundary the link
// can reach Radix's Slot unresolved during hydration, and Slot throws
// «Slot failed to slot onto its children» on some loads.
export function ButtonLink({ href, children, ...props }: ButtonLinkProps) {
  return (
    <Button asChild {...props}>
      <LocaleLink href={href}>{children}</LocaleLink>
    </Button>
  );
}
