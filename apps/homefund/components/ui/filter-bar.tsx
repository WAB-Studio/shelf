"use client";

import { useId, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select } from "@radix-ui/themes";

import styles from "./filter-bar.module.css";

/**
 * The row of narrowing controls under a screen header (RF-23, RF-89, RF-48).
 * Below `md` it keeps the page's gutter; from `md` up it takes the 32px of
 * SPEC-A3 so it lines up with the table beneath it.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className={styles.bar}>{children}</div>;
}

/**
 * One filter control. `label` is required and renders as a visible element tied
 * to the trigger by id, because the audit found bare controls named only by a
 * `<Text>` sitting beside them.
 */
export function FilterSelect({
  label,
  value,
  onValueChange,
  items,
  width,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  items: { value: string; label: string }[];
  width?: number;
}) {
  const controlId = useId();

  return (
    <div className={styles.field}>
      <label htmlFor={controlId} className={styles.label}>
        {label}
      </label>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger
          id={controlId}
          className={styles.trigger}
          style={width ? { width } : undefined}
        />
        <Select.Content position="popper">
          {items.map((item) => (
            <Select.Item key={item.value} value={item.value}>
              {item.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  );
}

/**
 * One date bound of a range filter. It wears the bar's own label and field
 * chrome instead of the theme's, so DESDE and HASTA read as part of the row
 * rather than as a form dropped into it (SPEC-A3).
 */
export function FilterDate({
  label,
  value,
  onValueChange,
  width,
}: {
  label: string;
  // The civil date the URL carries, or "" when the bound is not set.
  value: string;
  onValueChange: (v: string) => void;
  width?: number;
}) {
  const controlId = useId();

  return (
    <div className={styles.field}>
      <label htmlFor={controlId} className={styles.label}>
        {label}
      </label>
      <input
        id={controlId}
        type="date"
        className={styles.date}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        style={width ? { width } : undefined}
      />
    </div>
  );
}

/**
 * A narrowing already applied, or the dashed chip that adds one. An active chip
 * that can be removed is the control that removes it, named for the filter it
 * clears — no button nests inside another.
 */
export function FilterChip({
  label,
  active,
  onRemove,
  onClick,
  variant = "value",
}: {
  label: string;
  active?: boolean;
  onRemove?: () => void;
  onClick?: () => void;
  variant?: "value" | "add";
}) {
  const t = useTranslations("common");

  if (active && onRemove) {
    return (
      <button
        type="button"
        className={styles.chip}
        data-active=""
        aria-label={t("removeFilter", { label })}
        onClick={onRemove}
      >
        {label}
        <X size={12} aria-hidden />
      </button>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        className={styles.chip}
        data-active={active || undefined}
        data-variant={variant}
        onClick={onClick}
      >
        {variant === "add" && <Plus size={12} aria-hidden />}
        {label}
      </button>
    );
  }

  return (
    <span
      className={styles.chip}
      data-active={active || undefined}
      data-variant={variant}
    >
      {label}
    </span>
  );
}
