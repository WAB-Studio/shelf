import styles from "./figure.module.css";

// A count shown as a display figure: the number large in the display face, its unit under it
// (docs/wordbook/DESIGN.md "Verde botella"). Numbers are tabular on `body` already.
export function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.figure}>
      <span className={styles.value}>{value}</span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
