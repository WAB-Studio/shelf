import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import styles from "./mosaic.module.css";

/**
 * A grid of tiles of different sizes (large, medium, wide, small), read as one
 * board instead of a column of equal rows. Three tracks from `md`; below it the
 * tiles stack. `ink` is the deep-violet tile its figure shows in lime on.
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
