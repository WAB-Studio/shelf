"use client";

import { forwardRef } from "react";
import {
  Button as ThemesButton,
  IconButton as ThemesIconButton,
  type ButtonProps,
  type IconButtonProps,
} from "@radix-ui/themes";

import styles from "./button.module.css";

// docs/pulsar/DESIGN.md "The marks": every control is at least 48px on its
// shorter side. 44 is the one exception the design names, the light/dark
// control in the day's header, and it is asked for by name.
type TapSize = 44 | 48 | 52;

// docs/pulsar/DESIGN.md "The controls" dresses these three and no more. A
// variant the design has not dressed is not reachable: Radix's own `soft`,
// `surface` and `classic` paint from its scales, so they are typed away rather
// than left one keystroke behind a legal prop. `color` and `highContrast` go
// with them — both name a hue this design does not have.
type Variant = "solid" | "outline" | "ghost";

// `NoEncontrada.dc.html`'s own second action: a ghost that reads as a link
// rather than a way out, so its ink is the accent instead of `ghost`'s own
// muted. The only tone this design names; a screen reaching for another one
// is asking for a colour the token table does not have.
type Tone = "accent";

type PulsarControlProps = {
  tap?: TapSize;
  // Runs the control to the row's full width, for a sheet's own commit button.
  block?: boolean;
  // Lays the label and a hint under it in a column, left-aligned: a control
  // that names an act and says what it does (`MetasCentro`'s plan cards).
  stack?: boolean;
  variant?: Variant;
  tone?: Tone;
};

type Narrowed<P> = Omit<P, "variant" | "color" | "highContrast" | "radius">;

const variants: Record<Variant, string | undefined> = {
  solid: styles.solid,
  outline: styles.outline,
  ghost: styles.ghost,
};

function classes(
  { tap, block, stack, variant = "solid", tone }: PulsarControlProps,
  className: string | undefined,
): string {
  return [
    styles.control,
    tap === 44 ? styles.tap44 : tap === 52 ? styles.tap52 : styles.tap48,
    variants[variant],
    tone === "accent" ? styles.accentTone : undefined,
    block ? styles.block : undefined,
    stack ? styles.stack : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export const Button = forwardRef<HTMLButtonElement, Narrowed<ButtonProps> & PulsarControlProps>(
  function Button({ tap, block, stack, variant = "solid", tone, className, ...props }, ref) {
    return (
      <ThemesButton
        ref={ref}
        {...props}
        variant={variant}
        className={classes({ tap, block, stack, variant, tone }, className)}
      />
    );
  },
);

export const IconButton = forwardRef<
  HTMLButtonElement,
  Narrowed<IconButtonProps> & PulsarControlProps
>(function IconButton({ tap, block, variant = "solid", tone, className, ...props }, ref) {
  return (
    <ThemesIconButton
      ref={ref}
      {...props}
      variant={variant}
      className={classes({ tap, block, variant, tone }, className)}
    />
  );
});
