import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { expect, settled, type Person } from "./fixtures";

// Seeds and helpers for the specs of a goal's screen inside the tree (module 872, RP-79–RP-83).
// A helper file, not a spec. Every row is seeded under the spec's own disposable person; dates are
// relative to the harness's day, never fixed.

export type Db = postgres.Sql;
export type Unit = { measure: string; unit: string };
export const MINUTES: Unit = { measure: "minutos", unit: "minutos" };
export const KM: Unit = { measure: "km", unit: "km" };
export const WORDS: Unit = { measure: "palabras", unit: "palabras" };

export const today = todayInZone();
export const thisMonth = monthOf(today);
export const MONTH_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
export const monthWord = MONTH_LONG[Number(thisMonth.slice(5, 7)) - 1];

export function monthsAhead(n: number): string {
  let month = thisMonth;
  for (let i = 0; i < n; i += 1) month = nextMonth(month);
  return month;
}

// «hasta el 30 sep 2027», «30 de septiembre»: the day number and the month's first three letters
// are what a date of either spelling shares.
export function dateWords(day: string): RegExp {
  const month = MONTH_LONG[Number(day.slice(5, 7)) - 1].slice(0, 3);
  return new RegExp(`\\b${Number(day.slice(8, 10))} (?:de )?${month}`, "i");
}

export { dayBefore } from "@/lib/day/weeks";

export const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const createdAt = () => new Date(new Date(`${thisMonth}T12:00:00Z`).getTime() - 20 * 86_400_000);

export type SeedGoal = {
  name: string;
  parent?: string | null;
  unit?: Unit | null;
  // A first-of-month date, defaulting to five months ahead.
  horizon?: string;
  created?: Date;
  // This month's planned amount and what a fact today already reached.
  budget?: number;
  fact?: number;
  rhythm?: number;
  archived?: Date | null;
};

export async function seedGoal(db: Db, person: Person, o: SeedGoal): Promise<string> {
  const unit = o.unit ?? null;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, parent_id, horizon, measure_name, measure_unit, rhythm, created_at, archived_at)
    values (${person.id}, ${o.name}, ${o.parent ?? null}, ${o.horizon ?? monthsAhead(5)}::date, ${unit?.measure ?? null},
            ${unit?.unit ?? null}, ${o.rhythm ?? null}, ${o.created ?? createdAt()}, ${o.archived ?? null})
    returning id`;
  if (o.budget !== undefined) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${thisMonth}::date, ${o.budget})`;
  }
  if (o.fact !== undefined && unit) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Ronda', 'daily', 'quantity', 5, ${unit.unit}, now() - interval '60 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${goal.id}, ${today}::date, ${o.fact})`;
  }
  return goal.id;
}

// A task the goal asks every day, so Hoy draws the goal's group while it is open.
export async function seedDailyAsk(db: Db, person: Person, goalId: string, name: string) {
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goalId}, ${name}, 'daily', 'tap', now() - interval '3 days')`;
}

export type Tree = {
  G: string;
  g1: string;
  p: string;
  g2: string;
  names: { G: string; g1: string; p: string; g2: string };
};

// General G > large g1 > small p, and a second large g2 under G, all measuring minutes. g1 is
// inserted first (the position the plan orders by) but sorts after g2 by name, so an alphabetical
// list reads wrong. Month amounts: p 120 min with 60 reached, g2 60 with 30; g1 and G carry stored
// amounts and a rhythm of their own that must never be read.
export async function seedTree(db: Db, person: Person, stamp: number): Promise<Tree> {
  const names = {
    G: `General ${stamp}`,
    g1: `Zeta grande ${stamp}`,
    p: `Pequeña ${stamp}`,
    g2: `Alfa grande ${stamp}`,
  };
  const G = await seedGoal(db, person, { name: names.G, unit: MINUTES, horizon: monthsAhead(5), budget: 999, rhythm: 600 });
  const g1 = await seedGoal(db, person, { name: names.g1, parent: G, unit: MINUTES, horizon: monthsAhead(4), budget: 777, rhythm: 300 });
  const p = await seedGoal(db, person, { name: names.p, parent: g1, unit: MINUTES, horizon: monthsAhead(3), budget: 120, fact: 60 });
  const g2 = await seedGoal(db, person, { name: names.g2, parent: G, unit: MINUTES, horizon: monthsAhead(4), budget: 60, fact: 30 });
  return { G, g1, p, g2, names };
}

export async function archiveTogether(db: Db, ids: string[]) {
  await db`update goals.goals set archived_at = now() where id in ${db(ids)}`;
}

export async function archivedOf(db: Db, ids: string[]): Promise<Record<string, boolean>> {
  const rows = await db<{ id: string; archived: boolean }[]>`
    select id, archived_at is not null as archived from goals.goals where id in ${db(ids)}`;
  return Object.fromEntries(rows.map((row) => [row.id, row.archived]));
}

export async function openAs(browser: Browser, baseURL: string | undefined, person: Person, path: string, width = 360) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(path);
  await settled(page);
  return { page, context };
}

export function countActionPosts(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) calls.push(request.url());
  });
  return calls;
}

export async function holdActions(page: Page, ms = 1500) {
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}

export const mainText = async (page: Page) => flat(await page.locator("main").first().innerText());

// The visible link to a goal's screen inside the main region.
export const goalLink = (page: Page, id: string) => page.locator(`main a[href="/metas/${id}"]:visible`).first();

export async function expectTitle(page: Page, name: string) {
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}
