import type { ReactNode } from "react";
import { VisuallyHidden } from "@radix-ui/themes";

import styles from "./suggest-panel.module.css";

export type SuggestRow = { key: string; word: string; gloss: string | null; note: string | null };

// The field's own anchor and the panel of suggestions hanging under it (docs/wordbook/DESIGN.md
// «Gris frío y azul»). The keyboard and the open state belong to the caller; this draws them. Each
// row is an option the field names through `aria-activedescendant` (`optionId`), so focus never leaves the input.
export function suggestOptionId(id: string, index: number): string {
  return `${id}-option-${index}`;
}

export function SuggestPanel({
  id,
  label,
  rows,
  active,
  open,
  hintKeys,
  hintClose,
  onPick,
  children,
}: {
  id: string;
  label: string;
  rows: readonly SuggestRow[];
  active: number;
  open: boolean;
  hintKeys: string;
  hintClose: string;
  onPick: (word: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.anchor}>
      {children}
      {open && rows.length > 0 && (
        <div className={styles.panel}>
          <VisuallyHidden>{label}</VisuallyHidden>
          <div role="listbox" id={id} aria-label={label} className={styles.rows}>
            {rows.map((row, index) => (
              // The mouse never takes focus from the field: the press is swallowed, the click picks.
              <div
                key={row.key}
                id={suggestOptionId(id, index)}
                role="option"
                aria-selected={index === active}
                className={index === active ? `${styles.row} ${styles.active}` : styles.row}
                lang="en"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(row.word)}
              >
                <span className={styles.text}>
                  <span className={styles.word}>{row.word}</span>
                  {row.gloss !== null && <span className={styles.gloss} lang="es"> {row.gloss}</span>}
                </span>
                {row.note !== null && <span className={styles.note} lang="es">{row.note}</span>}
              </div>
            ))}
          </div>
          <div className={styles.foot} aria-hidden="true">
            <span>{hintKeys}</span>
            <span>{hintClose}</span>
          </div>
        </div>
      )}
    </div>
  );
}
