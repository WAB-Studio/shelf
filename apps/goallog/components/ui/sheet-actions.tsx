import type { ReactNode } from "react";

import styles from "./sheet-actions.module.css";

// A sheet's buttons as one group, written primary first. Below 1024px they
// stack full width as the sheet's own rhythm sets them; from it they are a row
// at the dialog's right edge, the secondary before the primary
// (`HojaEscritorio.dc.html`).
export function SheetActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
