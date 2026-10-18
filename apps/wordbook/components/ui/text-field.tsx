"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { TextField as ThemesTextField } from "@radix-ui/themes";

import styles from "./text-field.module.css";

// Every field is held to 44px tall, which the size tokens do not reach.
type RootProps = ComponentPropsWithoutRef<typeof ThemesTextField.Root>;

const Root = forwardRef<ComponentRef<typeof ThemesTextField.Root>, RootProps>(function Root(
  { className, ...props },
  ref,
) {
  return (
    <ThemesTextField.Root
      ref={ref}
      {...props}
      className={className ? `${styles.tap44} ${className}` : styles.tap44}
    />
  );
});

export const TextField = { Root, Slot: ThemesTextField.Slot };
