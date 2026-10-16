import type { ReactNode } from "react";

import styles from "./face.module.css";

// One screen, two faces (RNP-17): both are in the markup and the CSS shows one,
// so a screen never asks the width itself. `phone` draws below 1024px,
// `desktop` from it.
export function Face({
  on,
  as: Tag = "div",
  children,
}: {
  on: "phone" | "desktop";
  as?: "div" | "span";
  children?: ReactNode;
}) {
  return <Tag className={on === "phone" ? styles.phone : styles.desktop}>{children}</Tag>;
}
