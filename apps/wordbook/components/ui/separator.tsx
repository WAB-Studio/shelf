import { Separator as ThemesSeparator, type SeparatorProps } from "@radix-ui/themes";

import styles from "./separator.module.css";

// The one door onto Radix Themes' Separator. `weight="heavy"` is the
// `PalabraConFlexion` board's own boundary rule — 2px, thicker than the 1px
// hairline every other separator draws — the line that says "the entry
// ends here, the offer starts." `spanTracks` runs the rule under every track of
// the grid it sits in: `RegistroBorrarFila`'s rule lies under the link and the ✕.
export function Separator({
  className,
  weight,
  spanTracks,
  ...props
}: SeparatorProps & { weight?: "default" | "heavy"; spanTracks?: boolean }) {
  const heavy = weight === "heavy" ? styles.heavy : undefined;
  const span = spanTracks ? styles.spanTracks : undefined;
  const merged = [heavy, span, className].filter(Boolean).join(" ") || undefined;
  return <ThemesSeparator {...props} className={merged} />;
}
