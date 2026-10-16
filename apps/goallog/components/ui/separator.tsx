import { Separator as ThemesSeparator, type SeparatorProps } from "@radix-ui/themes";

import styles from "./separator.module.css";

// The hairline that rules one group from the next. docs/pulsar/DESIGN.md: never
// a card, never a border box. A `Row` draws its own; this is for everything else.
export function Separator({
  className,
  weight,
  ...props
}: Omit<SeparatorProps, "color" | "highContrast"> & {
  // `MesTodas.dc.html`: the 2px ink rule that opens a goal's block.
  weight?: "strong";
}) {
  const merged = [styles.rule, weight === "strong" ? styles.strong : undefined, className]
    .filter(Boolean)
    .join(" ");
  return (
    <ThemesSeparator
      size="4"
      {...props}
      className={merged}
    />
  );
}
