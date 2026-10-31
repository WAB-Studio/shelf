import type { ReactNode } from "react";

import { Disclosure, Meter, Rows, Text, type Tone } from "@/components/ui";

// `detail` opens under the row; `note` is a small line under it.
export type BarRow = { key: string; name: string; figure: string; seconds: number; label: string; detail?: ReactNode; note?: string; tone?: Tone };

// One meter per item, each bar a share of the longest. `featured` makes the first rows large and the rest compact.
// `tone` colours every row that names none of its own.
export function BarRows({ rows, featured, tone }: { rows: BarRow[]; featured?: number; tone?: Tone }) {
  const longest = Math.max(1, ...rows.map((row) => row.seconds));
  return (
    <Rows>
      {rows.map((row, index) => {
        const meter = (
          <Meter
            name={row.name}
            figure={row.figure}
            share={row.seconds / longest}
            label={row.label}
            tone={row.tone ?? tone}
            size={featured === undefined ? "default" : index < featured ? "large" : "compact"}
          />
        );
        const shown = row.detail === undefined ? meter : <Disclosure summary={meter}>{row.detail}</Disclosure>;
        return row.note === undefined ? (
          <div key={row.key}>{shown}</div>
        ) : (
          <div key={row.key}>
            {shown}
            <Text variant="meta" truncate>{row.note}</Text>
          </div>
        );
      })}
    </Rows>
  );
}
