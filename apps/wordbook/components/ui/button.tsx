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
};

function withTap(className: string | undefined): string {
  return className ? `${styles.tap} ${className}` : styles.tap;
}

function withBlock(block: boolean | undefined, className: string | undefined): string | undefined {
  if (!block) return className;
  return className ? `${styles.block} ${className}` : styles.block;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps & BlockProp>(
  function Button({ block, className, ...props }, ref) {
    return <ThemesButton ref={ref} {...props} className={withBlock(block, withTap(className))} />;
  },
);

type QuietProp = {
  // The glyph in the table's dimmest muted role (`--rl-muted-quiet`), never
  // Radix's own gray step: `RegistroBorrarFila`'s ✕ is the first to ask.
  quiet?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps & QuietProp>(
  function IconButton({ quiet, className, ...props }, ref) {
    const classes = quiet ? `${styles.quiet} ${withTap(className)}` : withTap(className);
    return <ThemesIconButton ref={ref} {...props} className={classes} />;
  },
);
