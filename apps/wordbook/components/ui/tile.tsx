import type { ReactNode } from "react";

import styles from "./tile.module.css";

// The recent words as a mosaic: `Mosaic` lays its tiles out, the first `big` one spanning two columns.
export function Mosaic({ children }: { children?: ReactNode }) {
  return <div className={styles.mosaic}>{children}</div>;
}

export function Tile({
  word,
  gloss,
  big,
  onClick,
}: {
  word: string;
  gloss: string | null;
  big?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={big ? `${styles.tile} ${styles.big}` : styles.tile} onClick={onClick} lang="en">
      <span className={styles.word}>{word}</span>
      {gloss !== null && (
        <span className={styles.gloss} lang="es">
          {gloss}
        </span>
      )}
    </button>
  );
}
