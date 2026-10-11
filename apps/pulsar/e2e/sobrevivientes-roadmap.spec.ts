import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// The roadmap train's mutation survivors, each pinned by what the person reads. Calendar-bound:
// «this month» is the current one. Every goal is seeded under this spec's own identity and
// deleted by id in `finally`.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const today = todayInZone();
const thisYear = today.slice(0, 4);
const m0 = monthOf(today);
const m1 = nextMonth(m0);
const m2 = nextMonth(m1);
const m3 = nextMonth(m2);
const m4 = nextMonth(m3);
const name = (month: string) =>
  month.slice(0, 4) === thisYear ? NAMES[Number(month.slice(5, 7)) - 1] : `${NAMES[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`;
const farHorizon = `${Number(thisYear) + 2}-01-01`;

type Db = postgres.Sql;
type Seed = { name: string; estimate: number | null; fixed?: string; done?: boolean; parent?: string };

async function seedGoal(db: Db, personId: string, rhythm: number | null, horizon: string, createdAgo = "3 days") {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta sobreviviente ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', ${rhythm}, now() - ${createdAgo}::interval)
    returning id
  `;
  return goal.id;
}

async function seedTasks(db: Db, personId: string, goalId: string, tasks: Seed[]) {
  const ids = new Map<string, string>();
  let position = 0;
  for (const task of tasks) {
    position += 1;
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month, parent_id, created_at)
      values (${personId}, ${goalId}, ${task.name}, ${task.estimate}, ${position}, true, ${task.fixed ?? null}::date,
        ${task.parent ? ids.get(task.parent)! : null}, now() - interval '3 days')
      returning id
    `;
    ids.set(task.name, row.id);
    if (task.done) {
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${personId}, ${goalId}, ${row.id}, ${today}::date)`;
    }
  }
}

async function drop(db: Db, personId: string, goalId: string) {
  await db`delete from goals.facts where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`update goals.one_offs set parent_id = null where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

const section = (page: Page, label: string) => page.locator("section").filter({ has: page.getByText(label, { exact: true }) });
const open = (page: Page, label: string) => page.getByRole("button", { name: new RegExp(`^${label}`) }).first().click();

test.use({ viewport: { width: 390, height: 900 } });

test("e04: a month inside the span with no task still draws its section", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 480, m4);
  await seedTasks(db, personId, goalId, [{ name: "Lejana", estimate: 60, fixed: m2 }]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await expect(section(page, `${name(m0)} · en curso`)).toBeVisible();
    await expect(section(page, name(m1))).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("e08: a month at 99.5 % draws a bar of 99, never a full one", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 200, m4);
  await seedTasks(db, personId, goalId, [{ name: "Llena", estimate: 200 }, { name: "Casi", estimate: 199 }]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    const fill = section(page, name(m1)).locator("span[aria-hidden] > span").first();
    expect(await fill.evaluate((el) => (el as HTMLElement).style.inlineSize)).toBe("99%");
  } finally {
    await drop(db, personId, goalId);
  }
});

test("e05/g11: a done task, or a parent with a done part, offers no «Borrar la tarea» on the plan; an open one does", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 960, m4);
  await seedTasks(db, personId, goalId, [
    { name: "Hecha", estimate: 30, done: true },
    { name: "Madre", estimate: null },
    { name: "Hija hecha", estimate: 20, parent: "Madre", done: true },
    { name: "Hija abierta", estimate: 20, parent: "Madre" },
    { name: "Libre", estimate: 30 },
  ]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    const sheet = page.getByRole("dialog");
    const del = sheet.getByRole("button", { name: "Borrar la tarea" });
    for (const [row, offered] of [["Hecha", 0], ["Madre", 0], ["Hija hecha", 0], ["Libre", 1]] as const) {
      await open(page, row);
      await expect(sheet.getByRole("button", { name: "Guardar" }).or(sheet.getByRole("button", { name: "Cancelar" })).first()).toBeVisible();
      await expect(del).toHaveCount(offered);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    }
  } finally {
    await drop(db, personId, goalId);
  }
});

test("e14: a pin is drawn on an open task, never on a done one", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 960, m4);
  await seedTasks(db, personId, goalId, [
    { name: "Hecha fijada", estimate: 30, fixed: m0, done: true },
    { name: "Abierta fijada", estimate: 30, fixed: m0 },
  ]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await expect(page.getByText(`Fijada en ${name(m0)}`)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Abierta fijada/ }).getByText(`Fijada en ${name(m0)}`)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Hecha fijada/ }).getByText(/Fijada en/)).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("e06: a parent's sheet offers the open months to pin to; a sub-task's sheet asks no month", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 960, m4);
  await seedTasks(db, personId, goalId, [
    { name: "Madre", estimate: null },
    { name: "Hija", estimate: 20, parent: "Madre" },
  ]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    const sheet = page.getByRole("dialog");
    await open(page, "Madre");
    await sheet.getByRole("radio", { name: /Fijarla en/ }).click();
    await expect(sheet.getByRole("radio", { name: name(m1) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await open(page, "Hija");
    await expect(sheet.getByRole("button", { name: "Guardar" })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: /Fijarla en/ })).toHaveCount(0);
    await expect(sheet.getByRole("radio", { name: name(m1) })).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("e07: the sheet says the month the plan would give a pinned task and a task that comes from an earlier month", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 480, m4);
  await seedTasks(db, personId, goalId, [
    { name: "Primera", estimate: 300 },
    { name: "Repartida", estimate: 480 },
    { name: "Fijada", estimate: 60, fixed: m3 },
  ]);
  try {
    await page.goto(`/metas/${goalId}/plan?todo=1`);
    const sheet = page.getByRole("dialog");
    // Unpinned, «Fijada» would queue behind «Repartida»'s tail in the second month.
    await section(page, name(m3)).getByRole("button", { name: /^Fijada/ }).click();
    await expect(sheet.getByText(`hoy: ${name(m1)}`, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await section(page, name(m1)).getByRole("button", { name: /^Repartida/ }).click();
    await expect(sheet.getByText(`hoy: ${name(m0)}`, { exact: true })).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("g07: a task's sheet on the month page says the month the plan gives it", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 480, m4);
  await seedTasks(db, personId, goalId, [{ name: "Una", estimate: 60 }]);
  try {
    await page.goto(`/metas/${goalId}/meses/${m0.slice(0, 7)}`);
    await open(page, "Una");
    await expect(page.getByRole("dialog").getByText(`hoy: ${name(m0)}`, { exact: true })).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("g10: a month page sums the parts its tasks hold, not their whole size", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 600, m4);
  await seedTasks(db, personId, goalId, [{ name: "Larga", estimate: 1500 }]);
  try {
    await page.goto(`/metas/${goalId}/meses/${m0.slice(0, 7)}`);
    await expect(page.getByText("tareas · 10 h", { exact: true })).toBeVisible();
    await expect(page.getByText("tareas · 25 h", { exact: true })).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("g02: the plan's end on the goal always carries its year, this one included", async ({ page, db, personId }) => {
  const soon = await seedGoal(db, personId, 480, farHorizon);
  await seedTasks(db, personId, soon, [{ name: "Corta", estimate: 60 }]);
  const late = await seedGoal(db, personId, 60, farHorizon);
  await seedTasks(db, personId, late, [{ name: "Larga", estimate: 840 }]);
  try {
    await page.goto(`/metas/${soon}`);
    await expect(page.getByText(/^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}$/u)).toBeVisible();
    await page.goto(`/metas/${late}`);
    await expect(page.getByText(/^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}$/u)).toBeVisible();
  } finally {
    await drop(db, personId, soon);
    await drop(db, personId, late);
  }
});

test("r01: a rhythm that ends on the goal's last day reads «a tiempo», not weeks late", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 720, m1);
  await seedTasks(db, personId, goalId, [{ name: "Entera", estimate: 720 }]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/^Con 12 h al mes terminas el \d{1,2} de \p{L}+ de \d{4}, a tiempo\./u)).toBeVisible();
    await expect(sheet.getByText(/después de tu final/)).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("r02: ten or eleven days late read «2 semanas», weeks rounded up", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 960, m1);
  await seedTasks(db, personId, goalId, [{ name: "Entera", estimate: 640 }]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await page.getByRole("button", { name: "Ritmo 16 h al mes" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: "8 h" }).click();
    await expect(sheet.getByText(/^Con 8 h al mes terminas el \d{1,2} de \p{L}+ de \d{4}, 2 semanas después de tu final\./u)).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("r04: an invalid rhythm is refused in the sheet and never sent", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 720, m4);
  await seedTasks(db, personId, goalId, [{ name: "Una", estimate: 60 }]);
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) sent.push(request.url());
  });
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByPlaceholder("otra").fill("0");
    await sheet.getByRole("button", { name: "Guardar el ritmo" }).click();
    await expect(sheet.getByText("El ritmo va de 1 min a 744 h al mes.")).toBeVisible();
    expect(sent).toEqual([]);
    const [row] = await db<{ rhythm: number }[]>`select rhythm from goals.goals where id = ${goalId}`;
    expect(row.rhythm).toBe(720);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("t01: 60 minutes are refused in the task sheet and nothing is saved", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 720, m4);
  await seedTasks(db, personId, goalId, [{ name: "Una", estimate: 60 }]);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await open(page, "Una");
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("spinbutton").nth(1).fill("60");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet.getByText("Los minutos van de 0 a 59.")).toBeVisible();
    const [row] = await db<{ estimate: number }[]>`select estimate from goals.one_offs where goal_id = ${goalId}`;
    expect(row.estimate).toBe(60);
  } finally {
    await drop(db, personId, goalId);
  }
});
