"use client";

import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import styles from "./color-swatch-picker.module.css";

// One radio per colour, all sharing `name`: the browser owns arrow-key and Tab navigation
// across the group on its own, with no key handler written here.
export function ColorSwatchPicker({
  id,
  name,
  value,
  onValueChange,
  colors,
  label,
  optionLabel,
  disabled,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: {
  id: string;
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  colors: readonly string[];
  label: string;
  optionLabel: (index: number) => string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <fieldset
      id={id}
      className={styles.fieldset}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.swatches}>
        {colors.map((color, index) => {
          const selected = color === value;
          return (
            <label
              key={color}
              className={styles.swatch}
              style={{ "--swatch-color": color } as CSSProperties}
            >
              <input
                type="radio"
                className={styles.input}
                name={name}
                value={color}
                checked={selected}
                disabled={disabled}
                aria-label={optionLabel(index)}
                onChange={() => onValueChange(color)}
              />
              {selected && (
                <span className={styles.check} aria-hidden>
                  <Check size={14} />
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// A stored colour, read-only: takes no `className` and no `style`, so no caller restyles it.
export function ColorSwatch({
  color,
  label,
}: {
  color: string;
  label?: string;
}) {
  return (
    <span
      className={styles.readOnlySwatch}
      style={{ "--swatch-color": color } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
