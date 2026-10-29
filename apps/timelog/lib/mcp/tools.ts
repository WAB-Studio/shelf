import { z } from "zod";

import { formatDuration } from "@/lib/duration";
import { daysOfWeek, mondayOf } from "@/lib/week";
import type { AppTime, DayTotal } from "@/lib/queries";
import { addDays, isCivilDay } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";
import time from "../../messages/es/time.json";

// What a tool reads, handed in so the shapes stay pure and testable without a database.
export type Reads = {
  appsBetween(from: string, to: string): Promise<AppTime[]>;
  dayTotals(from: string, to: string): Promise<DayTotal[]>;
};

export type ToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: keyof typeof mcp.errors };

export type ToolSpec = {
  name: keyof typeof mcp.tools;
  description: string;
  input: z.ZodObject;
  run(reads: Reads, input: Record<string, unknown>, today: string): Promise<ToolOutcome>;
};

export const MAX_RANGE_DAYS = 366;

const day = z.string().optional();

const timed = <T extends { seconds: number }>(row: T) => ({ ...row, text: formatDuration(row.seconds, time.duration) });

const sum = (rows: { seconds: number }[]) => rows.reduce((total, row) => total + row.seconds, 0);

// Every day from `from` to `to`, a day with nothing at zero.
function fill(from: string, to: string, totals: DayTotal[]): DayTotal[] {
  const secondsOn = new Map(totals.map((total) => [total.day, total.seconds]));
  const days: DayTotal[] = [];
  for (let one = from; one <= to; one = addDays(one, 1)) days.push({ day: one, seconds: secondsOn.get(one) ?? 0 });
  return days;
}

function dayOf(value: unknown, today: string): string | null {
  if (value === undefined) return today;
  return typeof value === "string" && isCivilDay(value) ? value : null;
}

async function span(reads: Reads, from: string, to: string) {
  const [totals, apps] = await Promise.all([reads.dayTotals(from, to), reads.appsBetween(from, to)]);
  return {
    days: fill(from, to, totals).map(timed),
    apps: apps.map(timed),
    total: timed({ seconds: sum(apps) }),
  };
}

export const tools: ToolSpec[] = [
  {
    name: "get_day",
    description: mcp.tools.get_day,
    input: z.object({ day }),
    async run(reads, input, today) {
      const one = dayOf(input.day, today);
      if (one === null) return { ok: false, error: "day" };
      const apps = await reads.appsBetween(one, one);
      return { ok: true, value: { day: one, apps: apps.map(timed), total: timed({ seconds: sum(apps) }) } };
    },
  },
  {
    name: "get_week",
    description: mcp.tools.get_week,
    input: z.object({ day }),
    async run(reads, input, today) {
      const one = dayOf(input.day, today);
      if (one === null) return { ok: false, error: "day" };
      const days = daysOfWeek(mondayOf(one));
      return { ok: true, value: { from: days[0], to: days[6], ...(await span(reads, days[0], days[6])) } };
    },
  },
  {
    name: "get_range",
    description: mcp.tools.get_range,
    input: z.object({ from: z.string(), to: z.string() }),
    async run(reads, input) {
      const { from, to } = input as { from: string; to: string };
      if (!isCivilDay(from) || !isCivilDay(to)) return { ok: false, error: "day" };
      if (from > to || addDays(from, MAX_RANGE_DAYS - 1) < to) return { ok: false, error: "range" };
      return { ok: true, value: { from, to, ...(await span(reads, from, to)) } };
    },
  },
];
