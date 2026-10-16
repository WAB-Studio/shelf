"use client";

import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from "react";

import styles from "./text-area.module.css";

type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "style"> & {
  label: string;
  // The value was refused: the ring turns ink.
  invalid?: boolean;
  // The refusal's sentence under the area, in ink.
  hint?: ReactNode;
};

// A labelled multi-line control in the mono the plan is pasted in, with the
// same ring `Field` draws.
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, invalid, hint, id, ...props },
  ref,
) {
  const generated = useId();
  const areaId = id ?? generated;
  const hintId = `${generated}-hint`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={areaId}>
        {label}
      </label>
      <textarea
        ref={ref}
        id={areaId}
        aria-describedby={hint ? hintId : undefined}
        aria-invalid={invalid ? true : undefined}
        {...props}
        className={styles.control}
      />
      {hint ? (
        <span id={hintId} className={styles.refusal}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});
