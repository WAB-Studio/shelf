"use client";

import {
  Bar,
  BarChart as RechartsBarChart,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

export type BarChartSeries = { key: string; valueCents: number };

export type BarChartDatum = { label: string; series: BarChartSeries[] };

// A grouped bar chart. The only door to Recharts: screens compose
// this, never the library. Values arrive as integer cents and map to bar
// geometry alone; the caller owns every label, legend and currency string.
export function BarChart({
  data,
  seriesColors,
  height = 240,
  formatValue,
  averageCents,
  averageLabel,
  "aria-label": ariaLabel,
}: {
  data: BarChartDatum[];
  seriesColors: Record<string, string>;
  height?: number;
  // Writes each bar's figure above it; an empty bar writes none.
  formatValue?: (cents: number) => string;
  // A dashed line across the chart at this value, named by `averageLabel`.
  averageCents?: number | null;
  averageLabel?: string;
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
        <RechartsBarChart data={rows} margin={{ top: formatValue ? 20 : 5 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis hide />
          {averageCents != null && averageCents > 0 && (
            <ReferenceLine
              y={averageCents}
              stroke="var(--gray-9)"
              strokeDasharray="4 4"
              label={{
                value: averageLabel,
                position: "insideTopLeft",
                fill: "var(--gray-11)",
                fontSize: 11,
              }}
            />
          )}
          {keys.map((key) => (
            <Bar key={key} dataKey={key} fill={seriesColors[key]} radius={4} isAnimationActive={false}>
              {formatValue && (
                <LabelList
                  dataKey={key}
                  position="top"
                  fill="var(--gray-11)"
                  fontSize={11}
                  formatter={(value: unknown) =>
                    typeof value === "number" && value > 0 ? formatValue(value) : ""
                  }
                />
              )}
            </Bar>
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
