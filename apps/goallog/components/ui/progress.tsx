import styles from "./progress.module.css";

// A thin bar of how much of a plan is reached, in ink on the line colour. It
// says nothing a sentence beside it does not, so a reader skips it.
// `thick` is the plan's month bar, 6px; the default is the goal's 4px.
export function Progress({ percent, size, brand }: { percent: number; size?: "thick"; brand?: boolean }) {
  const width = Math.min(100, Math.max(0, percent));
  const className = [styles.track, size === "thick" ? styles.thick : undefined, brand ? styles.brand : undefined].filter(Boolean).join(" ");
  return (
    <span aria-hidden data-part="progress-track" className={className}>
      <span className={styles.fill} style={{ inlineSize: `${width}%` }} />
    </span>
  );
}
