"use client";

import { forwardRef, useId, type ReactNode } from "react";
import { TextField, VisuallyHidden } from "@radix-ui/themes";

import styles from "./field.module.css";

// A labelled control, 48px tall, 10px of radius (docs/pulsar/DESIGN.md "The
// marks"). `hideLabel` is for the one-off field at the foot of the day, which
// carries a placeholder and no visible label: the name still reaches a reader.
// Radix's `classic` and `soft` paint from its own scales, and `color` names a
// hue this design does not have: one dressed surface, nothing else reachable.
type FieldProps = Omit<TextField.RootProps, "size" | "variant" | "color" | "radius"> & {
  label: string;
  hideLabel?: boolean;
  hint?: ReactNode;
  // The refusal reads in the hint's place, in ink, and the ring darkens.
  invalid?: boolean;
  // A unit read after the typed value («h», «min»), inside the control.
  suffix?: ReactNode;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hideLabel, hint, invalid, suffix, id, className, children, ...props },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${generated}-hint`;

  const labelNode = (
    <label className={styles.label} htmlFor={inputId}>
      {label}
    </label>
  );

  return (
    <div className={styles.field}>
      {hideLabel ? <VisuallyHidden asChild>{labelNode}</VisuallyHidden> : labelNode}
      <TextField.Root
        ref={ref}
        id={inputId}
        size="3"
        variant="surface"
        aria-describedby={hint ? hintId : undefined}
        aria-invalid={invalid ? true : undefined}
        {...props}
        className={[styles.control, className].filter(Boolean).join(" ")}
      >
        {children}
        {suffix ? (
          <TextField.Slot side="right" className={styles.suffix}>
            {suffix}
          </TextField.Slot>
        ) : null}
      </TextField.Root>
      {hint ? (
        <span id={hintId} className={invalid ? styles.refusal : styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});
