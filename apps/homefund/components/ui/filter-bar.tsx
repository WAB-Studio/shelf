"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select } from "@radix-ui/themes";

import { DateInput } from "./date-input";
import { ScopedSelectGroups } from "./scoped-select-groups";

import styles from "./filter-bar.module.css";

/**
 * The row of narrowing controls under a screen header (RF-23, RF-89, RF-125).
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
  scoped,
  width,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  items: { value: string; label: string }[];
  // Options after `items` that sit under a heading per scope when both hold some.
  scoped?: {
    fund: { value: string; label: string }[];
    personal: { value: string; label: string }[];
    fundHeading: string;
    personalHeading: string;
  };
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
          {scoped && (
            <ScopedSelectGroups
              fundHeading={scoped.fundHeading}
              personalHeading={scoped.personalHeading}
              fund={scoped.fund.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
              personal={scoped.personal.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            />
          )}
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
      <DateInput
        filter
        id={controlId}
        size="3"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        style={width ? { width } : undefined}
      />
    </div>
  );
}

// A pause in typing this long sends the text; each key restarts it, so a phone asks the server once per word.
const SEARCH_PAUSE_MS = 300;

/**
 * A text search in the filter row's own field chrome. It holds what is being typed and hands the
 * text on after a pause, so the caller's URL moves once per pause and not once per key. `value`
 * is only read back when it is cleared from outside.
 */
export function FilterSearch({
  label,
  placeholder,
  value,
  onValueChange,
  maxLength,
  width,
}: {
  label: string;
  placeholder: string;
  value: string;
  onValueChange: (v: string) => void;
  maxLength: number;
  // Fixed pixels on a laptop; omitted, the field takes the row it sits in.
  width?: number;
}) {
  const controlId = useId();
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);

  if (value !== seen) {
    setSeen(value);
    if (value === "") setDraft("");
  }

  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = setTimeout(() => onValueChange(draft.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [draft, value, onValueChange]);

  return (
    <div className={styles.field} style={width ? undefined : { flexGrow: 1 }}>
      <label htmlFor={controlId} className={styles.label}>
        {label}
      </label>
      <input
        id={controlId}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        className={styles.search}
        style={width ? { width } : undefined}
        placeholder={placeholder}
        maxLength={maxLength}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
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
