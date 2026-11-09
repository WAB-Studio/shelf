import { Plus } from "lucide-react";

import styles from "./add-button.module.css";

// The one act a phone screen offers from anywhere in it, fixed above the bottom nav. Named by what it
// opens, never by its glyph.
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.add} aria-label={label} onClick={onClick}>
      <Plus className={styles.icon} aria-hidden />
    </button>
  );
}
