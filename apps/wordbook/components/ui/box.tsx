import { Box as ThemesBox, type BoxProps } from "@radix-ui/themes";

import styles from "./box.module.css";

// The one door onto Radix Themes' Box. `rail` is the `PalabraConFlexion`
// board's own offer block — a 2px border-inline-start and an indent, 16px on
// desktop and 12px on mobile — the shape that says "this is offered beneath
// the entry above it," never a card or a border box.
//
// `muted` takes the muted role for every line inside it but links, which keep
// their door's colour: the dictionary block under a function word's table
// translation (`SinEntradaFraseFuncion`).
export function Box({ className, rail, muted, ...props }: BoxProps & { rail?: boolean; muted?: boolean }) {
  const base = [rail ? styles.rail : undefined, muted ? styles.muted : undefined].filter(Boolean).join(" ") || undefined;
  const merged = [base, className].filter(Boolean).join(" ") || undefined;
  return <ThemesBox {...props} className={merged} />;
}
