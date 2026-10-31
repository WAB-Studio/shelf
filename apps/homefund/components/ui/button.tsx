"use client";

import { forwardRef } from "react";
import {
  Button as ThemesButton,
  IconButton as ThemesIconButton,
  type ButtonProps,
  type IconButtonProps,
} from "@radix-ui/themes";

import styles from "./button.module.css";

// The one door onto Radix Themes' two buttons, so a screen that needs the floor
// asks for it here instead of drawing one.
type TapProp = {
  // On by default: every control holds 44px on both sides, which is what a
  // ghost variant or a size "1" or "2" otherwise falls under.
  // Pass `tap={false}` for a button inside a dense table cell, where the row is
  // the tap target and the cell keeps the height of its line.
  tap?: boolean;
  // Shares the free space of the row it sits in with its siblings.
  grow?: boolean;
};

function withTap(tap: boolean, className: string | undefined): string | undefined {
  if (!tap) return className;
  return className ? `${styles.tap} ${className}` : styles.tap;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps & TapProp>(
  function Button({ tap = true, grow, className, style, radius = "full", ...props }, ref) {
    // Pill-shaped by default: the brand's button (DESIGN.md «Violeta y lima»).
    return (
      <ThemesButton
        ref={ref}
        radius={radius}
        {...props}
        style={grow ? { flex: 1, ...style } : style}
        className={withTap(tap, className)}
      />
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps & TapProp>(
  function IconButton({ tap = true, className, radius = "full", ...props }, ref) {
    return <ThemesIconButton ref={ref} radius={radius} {...props} className={withTap(tap, className)} />;
  },
);
