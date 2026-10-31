import { Link as ThemesLink, type LinkProps } from "@radix-ui/themes";

import styles from "./link.module.css";

type MutedProp = {
  // The muted role `Text`'s own `muted` prop reaches (docs/wordbook/DESIGN.md
  // "Tokens"), never Radix's own `color="gray"` — `RegistroVaciar`'s own
  // link and its confirm screen's two destructive ones are the first to
  // need it.
  muted?: boolean;
  // Ink at rest, the accent only under the pointer: a link that is a whole row, not an invitation.
  ink?: boolean;
};

export function Link({ muted, ink, className, ...props }: LinkProps & MutedProp) {
  const classes = [muted ? styles.muted : undefined, ink ? styles.ink : undefined, className].filter(Boolean).join(" ");
  return <ThemesLink {...props} className={classes || undefined} />;
}
