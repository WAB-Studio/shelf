import { Text, type TextProps } from "@radix-ui/themes";

import styles from "./label.module.css";

// A part-of-speech label's exact type (docs/voyager/DESIGN.md "Type"): the
// sense it sits on is ruled with a hairline, never boxed, so this stays text.
// `muted` swaps the accent for `--rl-muted` — the `PalabraConFlexion` board's
// own offer label ("'left' también es una forma de 'leave'") reuses this
// same 11px/600/0.12em/uppercase shape, but the accent is reserved for a
// part of speech, not for an offer.
export function PosLabel({ className, muted, ...props }: TextProps & { muted?: boolean }) {
  const base = muted ? `${styles.label} ${styles.muted}` : styles.label;
  return <Text as="span" {...props} className={className ? `${base} ${className}` : base} />;
}
