import { Separator as ThemesSeparator, type SeparatorProps } from "@radix-ui/themes";

import styles from "./separator.module.css";

// The one door onto Radix Themes' Separator. `weight="heavy"` is the
// `PalabraConFlexion` board's own boundary rule — 2px, thicker than the 1px
// hairline every other separator draws — the line that says "the entry
// ends here, the offer starts."
export function Separator({
  className,
  weight,
  ...props
}: SeparatorProps & { weight?: "default" | "heavy" }) {
  const heavy = weight === "heavy" ? styles.heavy : undefined;
  const merged = [heavy, className].filter(Boolean).join(" ") || undefined;
  return <ThemesSeparator {...props} className={merged} />;
}
