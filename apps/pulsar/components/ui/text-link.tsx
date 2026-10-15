import Link from "next/link";
import type { ComponentProps } from "react";

import styles from "./text-link.module.css";

// docs/pulsar/DESIGN.md `SistemaPiezas`: the one link style, accent 15/500,
// underlined on hover and focus, a 48px target.
// `nowrap` keeps a short label on one line and out of a flex row's squeeze.
export function TextLink({ className, nowrap, ...props }: ComponentProps<typeof Link> & { nowrap?: boolean }) {
  const own = nowrap ? `${styles.link} ${styles.nowrap}` : styles.link;
  return <Link {...props} data-part="text-link" className={className ? `${own} ${className}` : own} />;
}
