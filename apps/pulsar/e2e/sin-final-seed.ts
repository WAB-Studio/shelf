import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Shared seeds of «sin final» (RP-99, RP-100): a goal with `horizon null` and a habit with `goal_id null`.
// Every date is read from the day the app reads, so a spec runs on any day of the week.

export const TODAY = todayInZone();
export const shift = (day: string, by: number): string => {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
};
export const MONTH_START = `${TODAY.slice(0, 7)}-01`;
// 0 is Monday.
export const TODAY_INDEX = (civilDateToDate(TODAY).getUTCDay() + 6) % 7;
export const WEEK_START = shift(TODAY, -TODAY_INDEX);

const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
export const monthStartOf = (offset: number): string => {
  const date = civilDateToDate(MONTH_START);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
export const monthLabel = (offset: number): string =>
  `${NAMES[Number(monthStartOf(offset).slice(5, 7)) - 1]} ${monthStartOf(offset).slice(0, 4)}`;
export const MONTH_WORD = NAMES[Number(MONTH_START.slice(5, 7)) - 1];

export const longDay = (day: string): string => {
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(civilDateToDate(day));
  return `${weekday} ${Number(day.slice(8, 10))}`;
};

type Db = postgres.Sql;
const LONG_AGO = () => new Date(Date.now() - 20 * 86_400_000);

export async function seedGoal(
  db: Db,
  personId: string,
  name: string,
  opts: { horizon?: string | null; unit?: string; budget?: number; created?: Date } = {},
): Promise<string> {
  const horizon = opts.horizon === undefined ? null : opts.horizon;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}, ${opts.unit ? opts.unit : null}, ${opts.unit ?? null}, ${opts.created ?? LONG_AGO()})
    returning id
  `;
  if (opts.budget !== undefined) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${personId}, ${goal.id}, ${MONTH_START}::date, ${opts.budget})
    `;
  }
  return goal.id;
}

export async function seedTap(db: Db, personId: string, goalId: string | null, name: string): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goalId}, ${name}, 'daily', 'tap', ${LONG_AGO()}) returning id
  `;
  return row.id;
}

export async function seedHabit(
  db: Db,
  personId: string,
  name: string,
  cadence:
    | { kind: "daily" }
    | { kind: "weekdays"; days: number[] }
    | { kind: "times_per_week"; n: number },
  satisfaction: { kind: "tap" } | { kind: "quantity"; target: number; unit: string } = { kind: "tap" },
  opts: { created?: Date; retired?: Date } = {},
): Promise<string> {
  const days = cadence.kind === "weekdays" ? cadence.days : null;
  const n = cadence.kind === "times_per_week" ? cadence.n : null;
  const quantity = satisfaction.kind === "quantity";
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays, satisfaction, target_quantity, unit, created_at, retired_at)
    values (${personId}, null, ${name}, ${cadence.kind}, ${n}, ${days}, ${satisfaction.kind},
            ${quantity ? satisfaction.target : null}, ${quantity ? satisfaction.unit : null}, ${opts.created ?? LONG_AGO()},
            ${opts.retired ?? null})
    returning id
  `;
  return row.id;
}

export async function seedFact(
  db: Db,
  personId: string,
  commitmentId: string,
  goalId: string | null,
  day: string,
  quantity: number | null = null,
): Promise<void> {
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${personId}, ${commitmentId}, ${goalId}, ${day}::date, ${quantity})
  `;
}

// The lowercase run of what the page draws (`innerText` applies the CSS uppercase), whitespace collapsed.
export const drawn = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
