"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Text } from "./text";
import styles from "./group-head.module.css";

// docs/goallog/DESIGN.md «Hoy»: a goal named once, over its rows. The phase is a tag and its sentence runs on one
// line, opened whole by a press; `trailing` is the goal's one figure.
export function GroupHead({
  name,
  tag,
  phase,
  expandLabel,
  collapseLabel,
  trailing,
}: {
  name: string;
  // «Fase 1 de 3».
  tag?: string;
  phase?: string;
  // What the phase line's press does next, for a screen reader.
  expandLabel?: string;
  collapseLabel?: string;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.head} data-part="group-head">
      <div className={styles.top}>
        <div className={styles.title}>
          <Text asChild variant="heading">
            <h2>{name}</h2>
          </Text>
          {tag ? <span className={styles.tag}>{tag}</span> : null}
        </div>
        {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
      </div>
      {phase ? (
        <button type="button" className={styles.phase} aria-expanded={open} aria-label={open ? collapseLabel : expandLabel} onClick={() => setOpen(!open)}>
          <span className={open ? styles.phaseOpen : styles.phaseText}>{phase}</span>
          <ChevronDown size={16} aria-hidden className={open ? styles.chevronOpen : styles.chevron} />
        </button>
      ) : null}
    </div>
  );
}
