import styles from "./figure.module.css";

// A count shown as a display figure: the number large in the display face, its unit under it
// (docs/wordbook/DESIGN.md "Verde botella"). Numbers are tabular on `body` already. `size="hero"` is
// the figure a card is about, 64px.
export function Figure({ value, label, size }: { value: number; label: string; size?: "hero" }) {
  return (
    <div className={styles.figure} role="group" aria-label={`${value} ${label}`}>
      <span className={size === "hero" ? `${styles.value} ${styles.hero}` : styles.value}>{value}</span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
