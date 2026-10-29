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
  // Holds the control to 44px on both sides, which is what a ghost variant
  // otherwise falls under.
  // A text label inside a table cell is not a control the floor applies to: the
  // row it sits in is the tap target, so the ledger's title link stays as tall
  // as its line.
  tap?: boolean;
  // Shares the free space of the row it sits in with its siblings.
  grow?: boolean;
};

function withTap(tap: boolean | undefined, className: string | undefined): string | undefined {
  if (!tap) return className;
  return className ? `${styles.tap} ${className}` : styles.tap;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps & TapProp>(
  function Button({ tap, grow, className, style, ...props }, ref) {
    return (
      <ThemesButton
        ref={ref}
        {...props}
        style={grow ? { flex: 1, ...style } : style}
        className={withTap(tap, className)}
      />
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps & TapProp>(
  function IconButton({ tap, className, ...props }, ref) {
    return <ThemesIconButton ref={ref} {...props} className={withTap(tap, className)} />;
  },
);
