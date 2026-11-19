"use client";

import { forwardRef } from "react";
import {
  Button as ThemesButton,
  IconButton as ThemesIconButton,
  type ButtonProps,
  type IconButtonProps,
} from "@radix-ui/themes";

import styles from "./button.module.css";

// The one door onto Radix Themes' two buttons: every control leaves here
// held to 44px on both sides, which a ghost variant otherwise falls under.
type BlockProp = {
  // Runs the button to the row's full width — `CuentaSinRed`'s retry is the
  // one place that asks for it, so it is a prop here rather than a style
  // reached from outside.
  block?: boolean;
  // Thickens an outline variant's rule to 1.5px; `Pedirlo` under «Copia» asks.
  heavy?: boolean;
  // 64px tall with a rounder corner: the review's grades, each carrying two lines.
  tall?: boolean;
};

// The classes a primitive adds to the caller's own, joined once.
function joined(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps & BlockProp>(
  function Button({ block, heavy, tall, className, ...props }, ref) {
    return <ThemesButton ref={ref} {...props} className={joined(tall && styles.tall, heavy && styles.heavy, block && styles.block, styles.tap, className)} />;
  },
);

type QuietProp = {
  // The glyph in the table's dimmest muted role (`--rl-muted-quiet`), never
  // Radix's own gray step: `RegistroBorrarFila`'s ✕ is the first to ask.
  quiet?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps & QuietProp>(
  function IconButton({ quiet, className, ...props }, ref) {
    return <ThemesIconButton ref={ref} {...props} className={joined(quiet && styles.quiet, styles.tap, className)} />;
  },
);
