import { Text, type TextProps } from "@radix-ui/themes";

import styles from "./meta-label.module.css";

// A metadata label's exact type (docs/voyager/DESIGN.md "Metadata labels"):
// PosLabel's shape — 11px / 600 / uppercase — but muted, never the accent,
// since the accent already names a part of speech.
export function MetaLabel({ className, ...props }: TextProps) {
  return (
    <Text
      as="span"
      {...props}
      className={className ? `${styles.label} ${className}` : styles.label}
    />
  );
}
