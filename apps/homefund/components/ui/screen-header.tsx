import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Flex, Heading } from "@radix-ui/themes";

import { Link as LocaleLink } from "@/i18n/navigation";
import styles from "./screen-header.module.css";

/**
 * The band every screen opens with (RF-125): the title, a secondary datum on its
 * baseline, the caller's actions at the end and, when the screen has one, its
 * headline figure under the title. Below `md` it is a bare
 * `Heading size="5"` inside the page's own gutter, so a screen that adopts it
 * does not shift on a phone; from `md` up it takes the 24/32/16 of SPEC-A3.
 */
export function ScreenHeader({
  title,
  meta,
  metaWraps,
  figure,
  actions,
  back,
}: {
  title: string;
  meta?: ReactNode;
  // The datum may take several lines: it wraps instead of holding one line.
  metaWraps?: boolean;
  // The one figure the screen is read for, on its own line under the title.
  figure?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <Flex asChild align="center" justify="between" gap="3" wrap="wrap">
      <header className={styles.header}>
        <Flex align="center" gap="3" minWidth="0">
          {back && (
            <LocaleLink
              href={back.href}
              aria-label={back.label}
              className={styles.back}
            >
              <ChevronLeft size={18} aria-hidden />
            </LocaleLink>
          )}
          <div className={styles.headline}>
            <Heading size="5" className={styles.title}>
              {title}
            </Heading>
            {meta && (
              <div className={metaWraps ? `${styles.meta} ${styles.metaWraps}` : styles.meta}>{meta}</div>
            )}
          </div>
        </Flex>
        {figure && <div className={styles.figure}>{figure}</div>}
        {actions && (
          <Flex align="center" gap="2">
            {actions}
          </Flex>
        )}
      </header>
    </Flex>
  );
}
