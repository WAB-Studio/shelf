import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// 826 (RP-74): `/meses` says each row's own plan. A goal that opens on the
// 16th of last month and ends on the 7th of this one plans its days' share of
// the rhythm in each: the whole rhythm in neither row. The amount a month sets
// itself is taken whole, and the sheet of a split month opens on the share.

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
// First day after the goal: it ends on the 7th of this month.
const horizon = `${thisMonth.slice(0, 8)}08`;
const RHYTHM = 600;

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];
const seg = (month: string) => month.slice(0, 7);

function lengthOf(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}
// RP-74: rhythm / month days, times the goal's days in the month, rounded down.
const firstShare = Math.floor((RHYTHM * (lengthOf(lastMonth) - 15)) / lengthOf(lastMonth));
const lastShare = Math.floor((RHYTHM * 7) / lengthOf(thisMonth));

function timeText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  return [h ? `${h} h` : "", min ? `${min} min` : ""].filter(Boolean).join(" ");
}

type Seed = { unit: string; name: string; rhythm: number; budgets?: Array<[string, number]>; endsOn?: string };

async function seedGoal(db: postgres.Sql, personId: string, input: Seed) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`${input.name} ${Date.now()}`}, ${input.endsOn ?? horizon}::date, ${input.unit}, ${input.unit}, ${input.rhythm},
      (${lastMonth}::date + 15) + time '12:00' at time zone 'UTC')
    returning id
  `;
  for (const [month, amount] of input.budgets ?? []) {
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${personId}, ${goal.id}, ${month}::date, ${amount})`;
  }
  return goal.id;
}

test.use({ viewport: { width: 360, height: 900 } });

test("Reto: the first month plans the part its days take, the last the part of its seven days, never the whole rhythm (826, RP-74)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, { unit: "minutos", name: "Reto", rhythm: RHYTHM });
  try {
    await page.goto(`/metas/${goalId}/meses`);
    const rows = page.locator("main ol > li");
    await expect(rows).toHaveCount(2);
    const first = rows.filter({ hasText: label(lastMonth) });
    const last = rows.filter({ hasText: label(thisMonth) });
    await expect(first).toContainText(new RegExp(`de ${timeText(firstShare).replace(/ /g, "\\s")}(?!\\s*\\d)`));
    await expect(last).toContainText(new RegExp(`de ${timeText(lastShare).replace(/ /g, "\\s")}(?!\\s*\\d)`));
    // Neither row carries the 10 h of the whole rhythm.
    await expect(rows.first()).not.toContainText(/de 10\sh/);
    await expect(rows.last()).not.toContainText(/de 10\sh/);
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("Bici: a month's own amount is taken whole in its row, even in the goal's first partial month (826, RP-74)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, {
    unit: "km",
    name: "Bici",
    rhythm: 400,
    budgets: [[lastMonth, 100]],
  });
  try {
    await page.goto(`/metas/${goalId}/meses`);
    const first = page.locator("main ol > li").filter({ hasText: label(lastMonth) });
    await expect(first).toContainText(/de 100\skm/);
    // The month without an amount of its own still plans its share of the 400 km: 7 days.
    const last = page.locator("main ol > li").filter({ hasText: label(thisMonth) });
    await expect(last).toContainText(new RegExp(`de ${Math.floor((400 * 7) / lengthOf(thisMonth))}\\skm`));
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

// An open goal: it ends on the 7th of next month, so next month is its split last one.
const followingMonth = nextMonth(thisMonth);
const openHorizon = `${followingMonth.slice(0, 8)}08`;
const followingShare = Math.floor((RHYTHM * 7) / lengthOf(followingMonth));

test("planning a split month opens the sheet on its part, not on the whole rhythm (826, RP-74)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, { unit: "minutos", name: "Planear", rhythm: RHYTHM, endsOn: openHorizon });
  try {
    await page.goto(`/metas/${goalId}/meses?planear=${seg(followingMonth)}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: `¿Cuánto en ${label(followingMonth)}?` })).toBeVisible();
    await expect(sheet.getByLabel("horas", { exact: true })).toHaveValue(String(Math.floor(followingShare / 60)));
    await expect(sheet.getByLabel("minutos", { exact: true })).toHaveValue(String(followingShare % 60));
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("the sheet offers to remove an amount only when the month stores one, never for a share of the rhythm (826, RP-74)", async ({
  page,
  db,
  personId,
}) => {
  const derived = await seedGoal(db, personId, { unit: "minutos", name: "Parte", rhythm: RHYTHM, endsOn: openHorizon });
  const stored = await seedGoal(db, personId, {
    unit: "minutos",
    name: "Propio",
    rhythm: RHYTHM,
    endsOn: openHorizon,
    budgets: [[followingMonth, 90]],
  });
  const remove = (sheet: ReturnType<typeof page.getByRole>) =>
    sheet.getByRole("button", { name: `quitar el monto de ${label(followingMonth)}` });
  try {
    await page.goto(`/metas/${derived}/meses?planear=${seg(followingMonth)}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByLabel("minutos", { exact: true })).toBeVisible();
    await expect(remove(sheet)).toHaveCount(0);

    await page.goto(`/metas/${stored}/meses?planear=${seg(followingMonth)}`);
    await expect(sheet.getByLabel("minutos", { exact: true })).toHaveValue("30");
    await expect(remove(sheet)).toBeVisible();
  } finally {
    await db`delete from goals.goals where id in (${derived}, ${stored})`;
  }
});
