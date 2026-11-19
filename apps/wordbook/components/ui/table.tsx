import type { ReactNode } from "react";
import NextLink from "next/link";

import styles from "./table.module.css";

// Registro's table: one column of days over a header of column names. A row is a grid of cells;
// its link covers the whole row from the word's cell, so the menu beside it stays a sibling of
// the link and never inside it. Below 1024px Estado and Hora are hidden; the word, its translation, Veces and the menu show.
type Column = "word" | "translation" | "state" | "times" | "time" | "menu";

function TableRoot({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div role="table" aria-label={label} className={styles.table}>
      {children}
    </div>
  );
}

function Head({ children }: { children?: ReactNode }) {
  return (
    <div role="row" className={styles.head}>
      {children}
    </div>
  );
}

function Heading({ column, children }: { column: Column; children?: ReactNode }) {
  return (
    <div role="columnheader" className={`${styles.cell} ${styles[column]}`}>
      {children}
    </div>
  );
}

function Day({ children }: { children?: ReactNode }) {
  return (
    <div role="row" className={styles.dayRow}>
      <div role="rowheader" className={styles.day}>
        {children}
      </div>
    </div>
  );
}

// `extra` hangs under the line at full width, indented as the cells are on the desktop: a question, a
// failure, the lines of a row that waits.
function Row({ extra, children }: { extra?: ReactNode; children?: ReactNode }) {
  return (
    <div role="row" className={styles.row}>
      <div className={styles.line}>{children}</div>
      {extra ? <div className={styles.extra}>{extra}</div> : null}
    </div>
  );
}

function Cell({ column, children }: { column: Column; children?: ReactNode }) {
  return (
    <div role="cell" className={`${styles.cell} ${styles[column]}`}>
      {children}
    </div>
  );
}

function Cover({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <NextLink href={href} prefetch={false} className={styles.cover}>
      {children}
    </NextLink>
  );
}

export const Table = { Root: TableRoot, Head, Heading, Day, Row, Cell, Cover };
