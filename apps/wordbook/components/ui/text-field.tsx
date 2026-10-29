"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { TextField as ThemesTextField } from "@radix-ui/themes";

import styles from "./text-field.module.css";

// Every field is held to 44px tall, which the size tokens do not reach.
// `edge` draws the field's border in `--rl-control-edge` (3:1), for the one
// field a reader must find; the rest keep the hairline.
type RootProps = ComponentPropsWithoutRef<typeof ThemesTextField.Root> & { edge?: boolean };

const Root = forwardRef<ComponentRef<typeof ThemesTextField.Root>, RootProps>(function Root(
  { className, edge, ...props },
  ref,
) {
  const classes = [styles.tap44, edge ? styles.edge : undefined, className].filter(Boolean).join(" ");
  return (
    <ThemesTextField.Root
      ref={ref}
      {...props}
      className={classes}
    />
  );
});

export const TextField = { Root, Slot: ThemesTextField.Slot };
