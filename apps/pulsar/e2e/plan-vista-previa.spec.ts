import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";

// RP-50 (module 816): before the first rhythm, each option says the month the
// plan really ends in, and the count of tasks that pass to the plan is the
// count the server releases. Written from the contract, not from the code:
// the seed is the critic's (10 h, four pending tasks fixed to a month, one of
// them a year ahead, plus a fixed parent whose sub-tasks are all done).

const today = todayInZone();
const thisYear = today.slice(0, 4);
const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

function monthAfter(count: number): string {
  let month = monthOf(today);
  for (let i = 0; i < count; i++) month = nextMonth(month);
  return month;
}

// «octubre», or «octubre de 2027» when it is not the year the person is in.
function spoken(month: string): string {
  const name = monthFormat.format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`));
  return month.slice(0, 4) === thisYear ? name : `${name} de ${month.slice(0, 4)}`;
}

const horizon = `${Number(thisYear) + 3}-12-01`;

type Seed = { goalId: string; fixed: string[]; doneParent: string };

// 4 pending fixed tasks of 1 h (one in the same month next year), 3 loose of
// 2 h: 10 h in all. A fixed parent with two sub-tasks, both with a fact, is
// done and stays where it is.
async function seedGoal(db: postgres.Sql, personId: string, rhythm: number | null = null): Promise<Seed> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm)
    values (${personId}, ${`Meta vista previa ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', ${rhythm})
    returning id
  `;
  const months = [monthAfter(2), monthAfter(3), monthAfter(1), monthAfter(12)];
  const fixed: string[] = [];
  let position = 1;
  for (const month of months) {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
      values (${personId}, ${goal.id}, ${`Fijada ${position}`}, 60, ${position}, true, ${month}::date)
      returning id
    `;
    fixed.push(row.id);
    position++;
  }
  for (let index = 1; index <= 3; index++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
      values (${personId}, ${goal.id}, ${`Suelta ${index}`}, 120, ${position++}, true)
    `;
  }
  const [parent] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, position, in_plan, planned_month)
    values (${personId}, ${goal.id}, 'Padre hecho', ${position++}, true, ${monthAfter(1)}::date)
    returning id
  `;
  for (const name of ["Hija 1", "Hija 2"]) {
    const [child] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, parent_id, name, position, in_plan)
      values (${personId}, ${goal.id}, ${parent.id}, ${name}, ${position++}, true)
      returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${personId}, ${goal.id}, ${child.id}, ${today})
    `;
  }
  return { goalId: goal.id, fixed, doneParent: parent.id };
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.facts where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

async function plannedMonths(db: postgres.Sql, goalId: string) {
  const rows = await db<{ id: string; planned_month: string | null }[]>`
    select id, planned_month::text from goals.one_offs where goal_id = ${goalId} and parent_id is null
  `;
  return new Map(rows.map((row) => [row.id, row.planned_month]));
}

// What the hint before the click says the plan ends in.
async function previewMonth(page: Page): Promise<string> {
  const hint = page.getByText(/^Con .+ al mes, tus .+ de tareas terminan en /);
  await expect(hint).toBeVisible();
  const text = (await hint.textContent()) ?? "";
  const match = /terminan en (.+?)\. Puedes/.exec(text);
  expect(match, text).not.toBeNull();
  return match![1];
}

// What the lead says after the click: «terminas el 31 de octubre de 2026».
async function leadMonth(page: Page): Promise<string> {
  const lead = page.getByText(/^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}/u);
  await expect(lead).toBeVisible();
  const text = (await lead.textContent()) ?? "";
  const match = /terminas el \d{1,2} de (\p{L}+) de (\d{4})/u.exec(text);
  expect(match, text).not.toBeNull();
  return match![2] === thisYear ? match![1] : `${match![1]} de ${match![2]}`;
}

async function choose(page: Page, option: string) {
  if (/^\d+ h$/.test(option) && ["8 h", "12 h", "20 h"].includes(option)) {
    await page.getByRole("radio", { name: option }).click();
  } else {
    await page.getByPlaceholder("otra").fill(option.replace(" h", ""));
  }
}

test.use({ viewport: { width: 390, height: 900 } });

// 10 h of tasks: 8 h a month runs into the next month, 12 h and 20 h end this
// one, 3 h takes four months. None of them is the month of the year-ahead
// task, because the first rhythm sends that task back to the plan.
const OPTIONS: { option: string; end: string }[] = [
  { option: "8 h", end: spoken(monthAfter(1)) },
  { option: "12 h", end: spoken(monthAfter(0)) },
  { option: "20 h", end: spoken(monthAfter(0)) },
  { option: "3 h", end: spoken(monthAfter(3)) },
  { option: "5", end: spoken(monthAfter(1)) },
];

for (const { option, end } of OPTIONS) {
  test(`«${option}»: the hint names the month the click leaves, ${end}`, async ({ page, db, personId }) => {
    const { goalId } = await seedGoal(db, personId);
    try {
      await visit(page, `/metas/${goalId}/plan`);
      await choose(page, option);
      const before = await previewMonth(page);
      expect(before).toBe(end);
      await page.getByRole("button", { name: "Armar el plan" }).click();
      expect(await leadMonth(page)).toBe(before);
    } finally {
      await drop(db, personId, goalId);
    }
  });
}

test("the options say different months: 8 h and 12 h do not both read the year-ahead task's", async ({
  page,
  db,
  personId,
}) => {
  const { goalId } = await seedGoal(db, personId);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByRole("radio", { name: "8 h" }).click();
    const eight = await previewMonth(page);
    await page.getByRole("radio", { name: "12 h" }).click();
    await expect(page.getByText(/^Con 12 h al mes/)).toBeVisible();
    const twelve = await previewMonth(page);
    expect(eight).not.toBe(twelve);
    expect(twelve).not.toContain(String(Number(thisYear) + 1));
  } finally {
    await drop(db, personId, goalId);
  }
});

test("«otra» rewrites the hint to its own month and back", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByPlaceholder("otra").fill("5 h");
    await expect(page.getByText(/^Con 5 h al mes/)).toBeVisible();
    expect(await previewMonth(page)).toBe(spoken(monthAfter(1)));
    await page.getByPlaceholder("otra").fill("10 h");
    await expect(page.getByText(/^Con 10 h al mes/)).toBeVisible();
    expect(await previewMonth(page)).toBe(spoken(monthAfter(0)));
  } finally {
    await drop(db, personId, goalId);
  }
});

test("the year in the hint is the person's, not the browser's", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId);
  // A browser a year ahead of the person's own calendar.
  const skew = Date.UTC(Number(thisYear) + 1, 5, 15) - Date.now();
  await page.addInitScript((offset) => {
    const Real = Date;
    class Skewed extends Real {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(Real.now() + offset);
        else super(...(args as [number]));
      }
      static now() {
        return Real.now() + offset;
      }
    }
    // @ts-expect-error replaced for the page
    window.Date = Skewed;
  }, skew);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByRole("radio", { name: "20 h" }).click();
    await expect(page.getByText(/^Con 20 h al mes/)).toBeVisible();
    expect(await previewMonth(page)).toBe(spoken(monthAfter(0)));
    await page.getByPlaceholder("otra").fill("3 h");
    await expect(page.getByText(/^Con 3 h al mes/)).toBeVisible();
    expect(await previewMonth(page)).toBe(spoken(monthAfter(3)));
  } finally {
    await drop(db, personId, goalId);
  }
});

test("the count is the tasks the server releases: a fixed parent with every sub-task done is not one", async ({
  page,
  db,
  personId,
}) => {
  const { goalId, fixed, doneParent } = await seedGoal(db, personId);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await expect(page.getByText(/^Las 4 tareas que tienen mes pasan al plan/)).toBeVisible();
    await expect(page.getByText(/^Las 5 tareas/)).toHaveCount(0);
    await page.getByRole("button", { name: "Armar el plan" }).click();
    await expect(page.getByRole("button", { name: "Armar el plan" })).toHaveCount(0);
    const after = await plannedMonths(db, goalId);
    const released = fixed.filter((id) => after.get(id) === null);
    expect(released).toHaveLength(4);
    expect(after.get(doneParent)).not.toBeNull();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("a goal with no fixed task says no count", async ({ page, db, personId }) => {
  const { goalId, fixed, doneParent } = await seedGoal(db, personId);
  await db`update goals.one_offs set planned_month = null where id = any(${[...fixed, doneParent]})`;
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await expect(page.getByRole("button", { name: "Armar el plan" })).toBeVisible();
    await expect(page.getByText(/tareas? que tienen? mes/)).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("the rhythm sheet of a goal with a rhythm keeps its fixed tasks: its end is theirs", async ({
  page,
  db,
  personId,
}) => {
  const { goalId, fixed } = await seedGoal(db, personId, 720);
  // The latest fixed task, six months out, holds the end where it is.
  await db`update goals.one_offs set planned_month = ${monthAfter(6)}::date where id = ${fixed[3]}`;
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: "20 h" }).click();
    const hint = sheet.getByText(/^Con 20 h al mes terminas el /);
    await expect(hint).toBeVisible();
    const name = monthFormat.format(new Date(`${monthAfter(6).slice(0, 7)}-01T12:00:00Z`));
    await expect(hint).toContainText(`de ${name}`);
    // Nothing was released by opening it.
    expect((await plannedMonths(db, goalId)).get(fixed[3])).not.toBeNull();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("«abc» draws no hint and the button answers with the schema's refusal", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByPlaceholder("otra").fill("abc");
    await expect(page.getByText(/terminan en /)).toHaveCount(0);
    await page.getByRole("button", { name: "Armar el plan" }).click();
    await expect(page.getByText("El ritmo va de 1 min a 744 h al mes.")).toBeVisible();
    const [row] = await db<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${goalId}`;
    expect(row.rhythm).toBeNull();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("while it saves the button is off and one request leaves", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId);
  let posts = 0;
  await page.route("**/metas/*/plan", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  try {
    await visit(page, `/metas/${goalId}/plan`);
    const button = page.getByRole("button", { name: "Armar el plan" });
    await button.click();
    await expect(button).toBeDisabled();
    await button.dispatchEvent("click");
    await expect(button).toHaveCount(0, { timeout: 15_000 });
    expect(posts).toBe(1);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("a goal that ended meanwhile: the server's refusal shows and nothing is saved", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await db`update goals.goals set archived_at = now() where id = ${goalId}`;
    await page.getByRole("button", { name: "Armar el plan" }).click();
    await expect(page.getByText("Esta meta ya terminó o está archivada.")).toBeVisible();
    const [row] = await db<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${goalId}`;
    expect(row.rhythm).toBeNull();
  } finally {
    await drop(db, personId, goalId);
  }
});
