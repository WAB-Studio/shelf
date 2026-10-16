"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import styles from "./fold.module.css";

// docs/goallog/DESIGN.md "Decisions of 2026-10-06": what no longer matters folds shut
// at the foot of its group (`ConexionesPlegadas`). The folded rows follow the
// button once it opens; shut, they are not in the page at all.
// `depth` lines the button up with a tree's rows, 16px in a level as `CheckRow` does; left out, it keeps the group's own edge.
// `defaultOpen` is read once, when it mounts; later presses are the person's.
export function Fold({ label, depth, defaultOpen = false, children }: { label: ReactNode; depth?: 0 | 1 | 2 | 3 | 4; defaultOpen?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button type="button" className={depth === undefined ? styles.fold : `${styles.fold} ${styles[`depth${depth}`]}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={16} aria-hidden className={open ? styles.open : styles.chevron} />
        {label}
      </button>
      {open ? children : null}
    </>
  );
}
