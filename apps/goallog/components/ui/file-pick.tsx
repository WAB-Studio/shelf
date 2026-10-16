"use client";

import { type ChangeEvent } from "react";

import styles from "./file-pick.module.css";

// A file control drawn as the outline button of docs/pulsar/DESIGN.md
// "Importar": a label over a muted hint. The native input stays in the page,
// out of sight, so a reader and a keyboard still reach it.
export function FilePick({
  label,
  hint,
  disabled,
  onPick,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  onPick: (file: File) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so the same file can be chosen again after a refusal.
    event.target.value = "";
    if (file) onPick(file);
  }

  return (
    <label className={styles.pick} data-disabled={disabled ? "" : undefined}>
      <input
        type="file"
        className={styles.input}
        disabled={disabled}
        onChange={handleChange}
      />
      <span className={styles.label}>{label}</span>
      <span className={styles.hint}>{hint}</span>
    </label>
  );
}
