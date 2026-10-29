import type { ComponentProps } from "react";

import { Link } from "@/i18n/navigation";

type PlainLinkProps = Omit<ComponentProps<typeof Link>, "style" | "className"> & {
  width?: string | number;
  alignSelf?: "flex-start" | "flex-end" | "center" | "stretch";
};

// The locale link with no underline and the colour of whatever holds it, for a
// whole card or banner that is one destination.
export function PlainLink({ width, alignSelf, ...props }: PlainLinkProps) {
  return (
    <Link
      {...props}
      style={{ textDecoration: "none", color: "inherit", width, alignSelf }}
    />
  );
}
