import type { ReactNode } from "react";

import { CategoryTile } from "./category-tile";
import styles from "./category-choice.module.css";

// The grid a category is picked from, a few tiles to a row.
export function CategoryChoiceGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

// One category as a tile over its name; pressing it picks it. `pressed` marks the
// chosen one for the reader as well as the eye.
export function CategoryChoice({
  label,
  color,
  pressed,
  icon,
  onClick,
}: {
  label: string;
  color: string | null;
  pressed?: boolean;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.choice}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <CategoryTile color={color} size={32} icon={icon} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
