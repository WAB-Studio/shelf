import Link from "next/link";

import { Text } from "./text";
import styles from "./summary-list.module.css";

export type SummaryRow = {
  key: string;
  href: string;
  name: string;
  // 0 at the top, 2 at most: the screen indents a goal under the one above it.
  level: 0 | 1 | 2;
  // The screen's lines, null where the goal has no amount: `noAmount` stands in the month's.
  month: string | null;
  week: string | null;
  // The paper's cells, null where the goal has no amount: «—» stands in.
  monthCell: string | null;
  weekCell: string | null;
};

// `ExportarResumen`: one row per goal. On screen a name over its month line and its week line;
// on paper the same rows are a three-column table under a head the screen never draws.
export function SummaryList({
  rows,
  head,
  noAmount,
}: {
  rows: SummaryRow[];
  head: { goal: string; month: string; week: string };
  noAmount: string;
}) {
  return (
    <div className={styles.list}>
      <div className={styles.head}>
        <Text variant="meta">{head.goal}</Text>
        <Text variant="meta">{head.month}</Text>
        <Text variant="meta">{head.week}</Text>
      </div>
      {rows.map((row) => (
        <Link
          key={row.key}
          href={row.href}
          className={`${styles.row} ${row.level === 1 ? styles.level1 : row.level === 2 ? styles.level2 : ""}`}
        >
          <Text as="span" variant="name" className={styles.name}>
            {row.name}
          </Text>
          <span className={styles.screen}>
            <Text as="span" variant="meta">
              {row.month ?? noAmount}
            </Text>
            {row.week !== null ? (
              <Text as="span" variant="meta">
                {row.week}
              </Text>
            ) : null}
          </span>
          <span className={styles.paper}>
            <Text as="span" variant="meta">
              {row.monthCell ?? "—"}
            </Text>
            <Text as="span" variant="meta">
              {row.weekCell ?? "—"}
            </Text>
          </span>
        </Link>
      ))}
    </div>
  );
}
