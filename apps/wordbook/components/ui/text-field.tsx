"use client";

import { forwardRef, useId, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { TextField as ThemesTextField } from "@radix-ui/themes";

import styles from "./text-field.module.css";

// Every field is held to 44px tall, which the size tokens do not reach.
// `edge` draws the field's border in `--rl-control-edge` (3:1), for the one
// field a reader must find; the rest keep the hairline. `label` draws the
// field's name above it, always visible, and names the input for a screen
// reader too.
type RootProps = ComponentPropsWithoutRef<typeof ThemesTextField.Root> & { edge?: boolean; label?: string };

const Root = forwardRef<ComponentRef<typeof ThemesTextField.Root>, RootProps>(function Root(
  { className, edge, label, id, ...props },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const classes = [styles.tap44, edge ? styles.edge : undefined, className].filter(Boolean).join(" ");
  const field = <ThemesTextField.Root ref={ref} {...props} id={inputId} className={classes} />;
  if (label === undefined) return field;
  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.label} data-field-label="">
        {label}
      </label>
      {field}
    </div>
  );
});

export const TextField = { Root, Slot: ThemesTextField.Slot };
