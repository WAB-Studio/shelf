import type { ReactNode } from "react";

import styles from "./tag.module.css";

// docs/goallog/DESIGN.md «Hoy»: where a goal stands, «Fase 1 de 3» or «Semana 6 de 12», a soft pill beside its name.
export function Tag({ children }: { children: ReactNode }) {
  return <span className={styles.tag}>{children}</span>;
}
