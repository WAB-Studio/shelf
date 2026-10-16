"use client";

import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import styles from "./chip-multi-select.module.css";

export type ChipOption = {
  id: string;
  name: string;
  color: string | null;
};

// One checkbox per option, all sharing `name`: the browser owns Tab and Space on
// its own, with no key handler written here.
export function ChipMultiSelect({
  id,
  name,
  value,
  onValueChange,
  options,
  label,
  disabled,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: {
  id: string;
  name: string;
  value: string[];
  onValueChange: (ids: string[]) => void;
  options: ChipOption[];
  label: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  // The next selection is rebuilt from `options`, never appended to `value`, so
  // the array the caller receives always reads in source order.
  function toggle(optionId: string) {
    const selected = new Set(value);
    if (selected.has(optionId)) {
      selected.delete(optionId);
    } else {
      selected.add(optionId);
    }

    onValueChange(
      options
        .filter((option) => selected.has(option.id))
        .map((option) => option.id),
    );
  }

  return (
    <fieldset
      id={id}
      className={styles.fieldset}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.chips}>
        {options.map((option) => {
          const selected = value.includes(option.id);
          return (
            <label key={option.id} className={styles.chip}>
              <input
                type="checkbox"
                className={styles.input}
                name={name}
                value={option.id}
                checked={selected}
                disabled={disabled}
                onChange={() => toggle(option.id)}
              />
              {/* `color` is a nullable column; a label stored without one keeps
                  its name and loses only the dot. */}
              {option.color && (
                <span
                  className={styles.dot}
                  style={{ "--chip-color": option.color } as CSSProperties}
                  aria-hidden
                />
              )}
              <span className={styles.name}>{option.name}</span>
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
