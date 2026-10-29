import type { ComponentProps, ReactNode } from "react";
import { Link } from "@radix-ui/themes";

import { Link as LocaleLink } from "@/i18n/navigation";

import { TapTarget } from "./tap-target";

// The text link of a screen: Radix's link ink on the locale link, held to the 44px floor.
export function TextLink({
  href,
  size,
  weight,
  align = "center",
  ...target
}: Pick<ComponentProps<typeof Link>, "size" | "weight"> &
  ComponentProps<typeof TapTarget> & {
    href: ComponentProps<typeof LocaleLink>["href"];
    children: ReactNode;
  }) {
  return (
    <Link asChild size={size} weight={weight}>
      <LocaleLink href={href}>
        <TapTarget align={align} {...target} />
      </LocaleLink>
    </Link>
  );
}
