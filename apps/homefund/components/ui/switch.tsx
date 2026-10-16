"use client";

import { forwardRef } from "react";
import { Switch as ThemesSwitch, type SwitchProps } from "@radix-ui/themes";

import styles from "./switch.module.css";

// The one door onto Radix Themes' switch. Every switch carries the floor: a
// screen has no size to ask for that would reach it, and none paints its own.
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch({ className, ...props }, ref) {
    return (
      <ThemesSwitch
        ref={ref}
        {...props}
        className={className ? `${styles.hit} ${className}` : styles.hit}
      />
    );
  },
);
