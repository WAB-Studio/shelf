import { Meter, Rows } from "@/components/ui";

export type BarRow = { key: string; name: string; figure: string; seconds: number; label: string };

// One meter per item, each bar a share of the longest. `featured` makes the first rows large and the rest compact.
export function BarRows({ rows, featured }: { rows: BarRow[]; featured?: number }) {
  const longest = Math.max(1, ...rows.map((row) => row.seconds));
  return (
    <Rows>
      {rows.map((row, index) => (
        <Meter
          key={row.key}
          name={row.name}
          figure={row.figure}
          share={row.seconds / longest}
          label={row.label}
          size={featured === undefined ? "default" : index < featured ? "large" : "compact"}
        />
      ))}
    </Rows>
  );
}
