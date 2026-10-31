"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";

import { Text } from "./text";
import styles from "./check-row.module.css";

// docs/goallog/DESIGN.md "Importar": a row the person marks in or out, the
// review's one shape. The checkbox is the native one, so a reader and the
// keyboard get it whole. The amount button sits beside the label, not in it:
// a label names one control, and the checkbox must not take the amount's name.
export function CheckRow({
  checked,
  onCheckedChange,
  disabled,
  name,
  meta,
  metaMore,
  boxLabel,
  note,
  reason,
  trailing,
  amount,
  amountLabel,
  onAmount,
  depth = 0,
  below,
  foldedNote,
  radio,
  unboxed,
}: {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name: ReactNode;
  // The quiet line under the name.
  meta?: ReactNode;
  // A second quiet line, under the first.
  metaMore?: ReactNode;
  // Names the checkbox when the row's visible words do not carry what it stands for.
  boxLabel?: string;
  // A task's note, whole, under the meta: read-only, its line breaks kept.
  note?: string | null;
  // A refusal's words, in ink under the meta.
  reason?: ReactNode;
  // Text at the end that opens nothing.
  trailing?: ReactNode;
  // An amount at the end that opens its edit; `amountLabel` names it for a reader.
  amount?: ReactNode;
  amountLabel?: string;
  onAmount?: () => void;
  // How deep the row sits in a tree: 16px in for each level, five levels at most.
  depth?: 0 | 1 | 2 | 3 | 4;
  // A block under the row, aligned to the name and outside the label: what the row's
  // own words are not (a correction to accept, a notice).
  below?: ReactNode;
  // A note kept shut behind a button that names it, read whole once opened.
  foldedNote?: { label: string; text: string };
  // A native radio of the named group instead of a checkbox: the row picks one of a list.
  radio?: string;
  // A row with nothing to mark: no control, the name stays level with the rows that have one.
  unboxed?: boolean;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <div className={`${styles.row} ${styles[`depth${depth}`]}`}>
      <label className={unboxed ? `${styles.label} ${styles.plain}` : styles.label}>
        {unboxed ? (
          <span className={styles.box} aria-hidden="true" />
        ) : (
          <input
            type={radio ? "radio" : "checkbox"}
            name={radio}
            className={styles.box}
            checked={checked}
            disabled={disabled}
            aria-label={boxLabel}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onCheckedChange?.(event.target.checked)
            }
          />
        )}
        <span className={styles.body}>
          <Text
            as="span"
            variant="body"
            tone={disabled && !checked && reason ? "muted" : "ink"}
          >
            {name}
          </Text>
          {meta ? (
            <Text as="span" variant="meta" tone="muted">
              {meta}
            </Text>
          ) : null}
          {metaMore ? (
            <Text as="span" variant="meta" tone="muted">
              {metaMore}
            </Text>
          ) : null}
          {note ? <span className={styles.note}>{note}</span> : null}
          {reason ? <span className={styles.reason}>{reason}</span> : null}
        </span>
        {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      </label>
      {amount !== undefined && amount !== null ? (
        <button
          type="button"
          className={styles.amount}
          aria-label={amountLabel}
          onClick={onAmount}
          disabled={disabled}
        >
          {amount}
        </button>
      ) : null}
      {foldedNote || below ? (
        <div className={styles.below}>
          {foldedNote ? (
            <button type="button" className={styles.noteButton} aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>
              {foldedNote.label}
            </button>
          ) : null}
          {foldedNote && noteOpen ? <span className={styles.note}>{foldedNote.text}</span> : null}
          {below}
        </div>
      ) : null}
    </div>
  );
}

// The review's confirm, held at the foot above the nav.
// `column` stands one card wide from 768px, for a review of one goal.
export function ActionBar({
  children,
  span = "full",
}: {
  children?: ReactNode;
  span?: "full" | "column";
}) {
  return (
    <div className={span === "column" ? `${styles.bar} ${styles.barColumn}` : styles.bar}>
      {children}
    </div>
  );
}
