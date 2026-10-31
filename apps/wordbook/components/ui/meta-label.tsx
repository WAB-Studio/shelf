import { Text, type TextProps } from "@radix-ui/themes";

import styles from "./meta-label.module.css";

// A metadata label's exact type (docs/wordbook/DESIGN.md "Metadata labels"):
// PosLabel's shape — 11px / 600 / uppercase — but muted, never the accent,
// since the accent already names a part of speech.
export function MetaLabel({ className, nowrap, ...props }: TextProps & { nowrap?: boolean }) {
  return (
    <Text
      as="span"
      {...props}
      className={[styles.label, nowrap ? styles.nowrap : undefined, className].filter(Boolean).join(" ")}
    />
  );
}
