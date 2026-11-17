"use client";

import { forwardRef } from "react";
import { Checkbox as ThemesCheckbox, type CheckboxProps } from "@radix-ui/themes";

import styles from "./checkbox.module.css";

// The one door onto Radix Themes' checkbox. Every checkbox carries the floor: a screen has no size to ask for
// that would reach it, and none paints its own.
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <ThemesCheckbox
        ref={ref}
        {...props}
        className={className ? `${styles.hit} ${className}` : styles.hit}
      />
    );
  },
);
