import { Meter, Stack } from "@/components/ui";

export type BarRow = { key: string; name: string; figure: string; seconds: number; label: string };

// One meter per item, each bar a share of the longest (DESIGN «Hoy», «Semana»).
export function BarRows({ rows }: { rows: BarRow[] }) {
  const longest = Math.max(1, ...rows.map((row) => row.seconds));
  return (
    <Stack gap={2}>
      {rows.map((row) => (
        <Meter key={row.key} name={row.name} figure={row.figure} share={row.seconds / longest} label={row.label} />
      ))}
    </Stack>
  );
}
