"use client";

import {
  Bar,
  BarChart as RechartsBarChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

export type BarChartSeries = { key: string; valueCents: number };

export type BarChartDatum = { label: string; series: BarChartSeries[] };

// A grouped two-series bar chart. The only door to Recharts: screens compose
// this, never the library. Values arrive as integer cents and map to bar
// geometry alone; the caller owns every label, legend and currency string.
export function BarChart({
  data,
  seriesColors,
  height = 240,
  "aria-label": ariaLabel,
}: {
  data: BarChartDatum[];
  seriesColors: Record<string, string>;
  height?: number;
  "aria-label": string;
}) {
  // Recharts wants one flat object per group with a field per series key.
  const rows = data.map((datum) => {
    const row: Record<string, number | string> = { label: datum.label };
    for (const { key, valueCents } of datum.series) {
      row[key] = valueCents;
    }
    return row;
  });

  const keys = Object.keys(seriesColors);

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height={height}>
        <RechartsBarChart data={rows}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis hide />
          {keys.map((key) => (
            <Bar key={key} dataKey={key} fill={seriesColors[key]} radius={4} />
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
