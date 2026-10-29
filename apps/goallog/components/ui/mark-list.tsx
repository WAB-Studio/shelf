import type { ReactNode } from "react";

import styles from "./mark-list.module.css";

// A list whose every line leads with one glyph («+», «–»), the consent
// screen's «podrá» and «nunca». The glyph is decoration: a reader hears the lines.
export function MarkList({ mark, items }: { mark: string; items: { key: string; node: ReactNode }[] }) {
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.key} className={styles.item}>
          <span className={styles.mark} aria-hidden>
            {mark}
          </span>
          {item.node}
        </li>
      ))}
    </ul>
  );
}
