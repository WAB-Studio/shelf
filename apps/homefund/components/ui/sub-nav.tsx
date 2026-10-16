import { Link as LocaleLink } from "@/i18n/navigation";
import styles from "./sub-nav.module.css";

/**
 * The chips that move between the sections of one area — Planeación's four, a
 * settings screen's tabs (RF-71, RF-74, RF-76, RF-29, RF-83). Every chip is a
 * real locale-aware link, so a section is reachable by URL and by a new tab.
 */
export function SubNav({
  label,
  items,
}: {
  label: string;
  items: { key: string; href: string; label: string; current: boolean }[];
}) {
  return (
    <nav aria-label={label} className={styles.nav}>
      {items.map((item) => (
        <LocaleLink
          key={item.key}
          href={item.href}
          className={styles.chip}
          data-current={item.current || undefined}
          aria-current={item.current ? "page" : undefined}
        >
          {item.label}
        </LocaleLink>
      ))}
    </nav>
  );
}
