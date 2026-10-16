import styles from "./code-block.module.css";

// A text to be read and copied exactly as written: mono, on the raised
// surface, a hairline round it, long lines wrapped rather than scrolled.
export function CodeBlock({ children }: { children: string }) {
  return <pre className={styles.block}>{children}</pre>;
}
