import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import styles from "./mosaic.module.css";

/**
 * A grid of tiles of different sizes (large, medium, wide, small), read as one
 * board instead of a column of equal rows. One column on a phone, three tracks from `md`. `ink` is the deep-violet tile its figure shows in lime on.
 */
export function Mosaic({ children }: { children: ReactNode }) {
  return <div className={styles.mosaic}>{children}</div>;
}

export function MosaicTile({
  href,
  size,
  tone = "plain",
  children,
}: {
  href: string;
  size: "large" | "medium" | "wide" | "small";
  tone?: "plain" | "ink";
  children: ReactNode;
}) {
  return (
    <Link href={href} className={styles.tile} data-size={size} data-tone={tone}>
      {children}
    </Link>
  );
}

// The ink tile's headline figure (lime) and its quiet note.
export function MosaicFigure({ children }: { children: ReactNode }) {
  return <span className={styles.figure}>{children}</span>;
}

export function MosaicNote({ children }: { children: ReactNode }) {
  return <span className={styles.note}>{children}</span>;
}
