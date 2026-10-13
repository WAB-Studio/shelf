import type { Browser, Locator, Page } from "@playwright/test";

import { dayBefore } from "@/lib/day/weeks";
import { civilDayMonthYear } from "@/lib/zone";

import { expect, type Person } from "./fixtures";
import { MONTH_LONG, monthsAhead, today, thisMonth, type Db, type Unit } from "./meta-arbol-seed";

// Seeds and helpers of the specs of «sin final», the rhythm in any unit and the loose habits
// (module 916, RP-99–RP-101). A helper file, not a spec. Every row belongs to the spec's own
// disposable person; dates are relative to the harness's day.

export const PAGES: Unit = { measure: "páginas", unit: "páginas" };
export const MINUTES: Unit = { measure: "minutos", unit: "minutos" };

// A moment inside the current month, on `day` (capped at today's number so it is never ahead).
export function openedOnDay(day: number): { at: Date; day: number } {
  const d = Math.min(day, Number(today.slice(8, 10)));
  return { at: new Date(`${thisMonth.slice(0, 8)}${String(d).padStart(2, "0")}T12:00:00Z`), day: d };
}

export const daysInThisMonth = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)), 0)).getUTCDate();

// RP-76: the rhythm spread evenly over the month's days, summed over the goal's days in it, rounded down.
export const firstMonthShare = (rhythm: number, openedDay: number) =>
  Math.floor((rhythm * (daysInThisMonth - openedDay + 1)) / daysInThisMonth);

export type OpenGoal = {
  name: string;
  parent?: string | null;
  unit?: Unit | null;
  // null is the point: a goal that never ends.
  horizon?: string | null;
  rhythm?: number | null;
  created?: Date;
  note?: string | null;
};

export async function seedOpenGoal(db: Db, person: Person, o: OpenGoal): Promise<string> {
  const unit = o.unit ?? null;
  const horizon = o.horizon === undefined ? monthsAhead(5) : o.horizon;
  const created = o.created ?? new Date(Date.now() - 20 * 86_400_000);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, parent_id, horizon, measure_name, measure_unit, rhythm, created_at, note)
    values (${person.id}, ${o.name}, ${o.parent ?? null}, ${horizon}::date, ${unit?.measure ?? null}, ${unit?.unit ?? null},
            ${o.rhythm ?? null}, ${created}, ${o.note ?? null})
    returning id`;
  return goal.id;
}

export async function horizonOfGoal(db: Db, id: string): Promise<string | null> {
  const [row] = await db<{ horizon: string | null }[]>`select horizon::text as horizon from goals.goals where id = ${id}`;
  return row.horizon;
}

export async function rhythmOfGoal(db: Db, id: string): Promise<number | null> {
  const [row] = await db<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${id}`;
  return row.rhythm;
}

export type Habit = {
  name: string;
  cadence?: "daily" | "weekdays" | "times_per_week";
  weekdays?: number[];
  n?: number;
  quantity?: number;
  unit?: string;
  note?: string | null;
  retired?: boolean;
};

// A commitment that belongs to no goal (RP-100).
export async function seedHabit(db: Db, person: Person, h: Habit): Promise<string> {
  const cadence = h.cadence ?? "daily";
  const quantity = h.quantity !== undefined;
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays, satisfaction,
                                   target_quantity, unit, note, created_at, retired_at)
    values (${person.id}, null, ${h.name}, ${cadence}, ${h.n ?? null}, ${h.weekdays ?? null},
            ${quantity ? "quantity" : "tap"}, ${h.quantity ?? null}, ${quantity ? (h.unit ?? null) : null},
            ${h.note ?? null}, now() - interval '30 days', ${h.retired ? new Date() : null})
    returning id`;
  return row.id;
}

export async function habitRows(db: Db, person: Person, name: string) {
  return db<{ id: string; goal_id: string | null; note: string | null; retired_at: string | null; cadence_kind: string; cadence_n: number | null }[]>`
    select id, goal_id, note, retired_at, cadence_kind, cadence_n from goals.commitments
    where user_id = ${person.id} and name = ${name}`;
}

export async function countCommitments(db: Db, person: Person): Promise<number> {
  const [row] = await db<{ n: string }[]>`select count(*)::text as n from goals.commitments where user_id = ${person.id}`;
  return Number(row.n);
}

export async function visit(browser: Browser, baseURL: string | undefined, person: Person, path: string, width: number) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main")).toBeVisible();
  return { page, context };
}

// Lower-cased, one-line text of the main region: section rótulos are drawn uppercase by CSS, which
// `innerText` hands back transformed.
export async function mainLower(page: Page): Promise<string> {
  // The loading fallback is a `main` too: anchor on the real page's title, then on a quiet network.
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  return (await page.locator("main").first().innerText()).replace(/\s+/g, " ").trim().toLowerCase();
}

// The text between two section rótulos (the end optional).
export function between(text: string, from: string, to?: string): string {
  const start = text.indexOf(from);
  if (start < 0) return "";
  const rest = text.slice(start + from.length);
  const end = to ? rest.indexOf(to) : -1;
  return end < 0 ? rest : rest.slice(0, end);
}

export const monthLabel = (month: string) => `${MONTH_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export const endLine = (horizon: string) => civilDayMonthYear(dayBefore(horizon));

export function postCounter(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) calls.push(request.url());
  });
  return calls;
}

export const dialog = (page: Page): Locator => page.getByRole("dialog");

// A task of the goal's plan (time) or pinned to this month (any other unit).
export async function seedTask(db: Db, person: Person, goalId: string, name: string, inTime: boolean) {
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
    values (${person.id}, ${goalId}, ${name}, ${inTime ? 240 : null}, 1, true, ${inTime ? null : thisMonth}::date)`;
}
