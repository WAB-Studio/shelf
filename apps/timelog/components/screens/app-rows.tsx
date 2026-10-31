import type { ReactNode } from "react";

import { Disclosure, Meter, Rows, Text, type Tone } from "@/components/ui";

// `detail` opens under the row; `note` is a small line under it; `wrap` gives a long name two lines (a detail is opened to be read).
export type BarRow = { key: string; name: string; figure: string; seconds: number; label: string; detail?: ReactNode; note?: string; tone?: Tone; wrap?: boolean };

// One meter per item, each bar a share of the longest. `featured` makes the first rows large and the rest compact.
// `tone` colours every row that names none of its own. `of` is the whole a bar is a share of: a child row names its
// parent's time, so a window never draws as long as the app it sits in; without it, the longest row.
export function BarRows({ rows, featured, tone, of }: { rows: BarRow[]; featured?: number; tone?: Tone; of?: number }) {
  const longest = Math.max(1, of ?? 0, ...(of === undefined ? rows.map((row) => row.seconds) : []));
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
            wrap={row.wrap}
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
