import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { expect, settled } from "./fixtures";

// Seeds for the specs of `JerarquiaHoy` (RP-84): goals in three fixed levels
// (general → large → small), commitments, month amounts. A helper file, not a spec.

export const today = todayInZone();
export const monthStart = `${today.slice(0, 7)}-01`;
export const isoWeekday = ((civilDateToDate(today).getUTCDay() + 6) % 7) + 1;
export const MONTH_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

export function plusDays(days: number): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// The sentence of the given ISO weekdays, ascending: «lun, mié y vie».
export function sentence(weekdays: number[]): string {
  const names = [...weekdays].sort((a, b) => a - b).map((day) => SHORT[day - 1]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

export const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Db = postgres.Sql;

export async function seedGoal(
  db: Db,
  personId: string,
  name: string,
  parentId: string | null = null,
  unit: string | null = "minutos",
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
    values (${personId}, ${name}, ${plusDays(90)}::date, ${unit}, ${unit}, ${parentId}, now() - interval '30 days')
    returning id
  `;
  return goal.id;
}

export async function seedBudget(db: Db, personId: string, goalId: string, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goalId}, ${monthStart}::date, ${amount})
  `;
}

// A task of the month already done today, with `minutes` as its estimate: it plans the month and reaches nothing (RP-128).
export async function seedReached(db: Db, personId: string, goalId: string, minutes: number) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${personId}, ${goalId}, ${`Hecha ${goalId}`}, ${monthStart}::date, ${minutes}) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${personId}, ${goalId}, ${task.id}, ${today}::date)
  `;
}

// A commitment due today, asked by the tap or by an amount.
export async function seedCommitment(
  db: Db,
  personId: string,
  goalId: string,
  name: string,
  opts: { weekdays?: number[]; amount?: number } = {},
): Promise<string> {
  const quantity = opts.amount !== undefined;
  const [row] = opts.weekdays
    ? await db<{ id: string }[]>`
        insert into goals.commitments
          (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, target_quantity, unit, created_at)
        values (${personId}, ${goalId}, ${name}, 'weekdays', ${opts.weekdays}, ${quantity ? "quantity" : "tap"},
                ${quantity ? opts.amount! : null}, ${quantity ? "minutos" : null}, now() - interval '30 days')
        returning id
      `
    : await db<{ id: string }[]>`
        insert into goals.commitments
          (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
        values (${personId}, ${goalId}, ${name}, 'daily', ${quantity ? "quantity" : "tap"},
                ${quantity ? opts.amount! : null}, ${quantity ? "minutos" : null}, now() - interval '30 days')
        returning id
      `;
  return row.id;
}

// The weekday that is never today.
export const notToday = (isoWeekday % 7) + 1;

export function row(page: Page, name: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}`) }).locator("visible=true");
}

// Position in reading order (document order) of a box: the desktop lays groups
// in columns, so a vertical offset cannot say which comes first.
export async function indexOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => Array.from(document.querySelectorAll("*")).indexOf(el));
}

// The first visible box carrying exactly this text: a goal's name may also
// stand lower on the page (its month line), the group's label is the first.
export async function topOf(page: Page, text: string): Promise<number> {
  const found = await page.getByText(text, { exact: true }).locator("visible=true").all();
  const at: number[] = [];
  for (const one of found) at.push(await indexOf(one));
  return at.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...at);
}

export async function topOfRow(page: Page, name: string): Promise<number> {
  const one = row(page, name).first();
  await one.waitFor();
  return indexOf(one);
}

// Elements that read exactly `text` and sit in no button or link: a label or a
// line of its own, never a row's second line.
export async function standalone(page: Page, text: string): Promise<number> {
  return page.evaluate((wanted) => {
    let count = 0;
    for (const el of Array.from(document.querySelectorAll("main *"))) {
      if (el.children.length > 0) continue;
      if ((el.textContent ?? "").trim() !== wanted) continue;
      if (el.closest("button, a")) continue;
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) count += 1;
    }
    return count;
  }, text);
}

export async function open(page: Page): Promise<void> {
  await page.goto("/");
  await settled(page);
  await expect(page.getByRole("button", { name: /\S/ }).first()).toBeVisible();
}
