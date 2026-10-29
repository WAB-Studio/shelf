import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

// `HoyMes.dc.html`, `HoyMesBajo.dc.html`: Hoy says each goal's
// month amount in hours and minutes, and from the 20th a goal under 60 % says
// its pace. The pace branch follows the clock the app reads, so both branches
// are written and the one true today is asserted.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("Hoy draws the month line in hours and minutes, the pace line from the 20th, and none on a past day", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const today = todayInZone();
  const monthStart = `${today.slice(0, 7)}-01`;
  const late = Number(today.slice(8, 10)) >= 20;
  const underName = `Meta bajo ${stamp}`;
  const exactName = `Meta justa ${stamp}`;
  const bareName = `Meta sin monto ${stamp}`;

  const seedGoal = async (name: string, budget: number | null) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${name}, ${plusDays(90)}, 'minutos', 'minutos', now() - interval '40 days')
      returning id
    `;
    if (budget !== null) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${monthStart}::date, ${budget})
      `;
    }
    return goal.id;
  };
  const quantity = async (goalId: string, name: string, minutes: number, day: string) => {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goalId}, ${name}, 'daily', 'quantity', 30, 'minutos', now() - interval '40 days')
      returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goalId}, ${commitment.id}, ${day}::date, ${minutes})
    `;
  };

  // 720 planned: 300 + 90 declared reach 390, 54 %; a done 15-minute task adds nothing (RP-128).
  const under = await seedGoal(underName, 720);
  await quantity(under, `Sesión A ${stamp}`, 300, monthStart);
  await quantity(under, `Sesión B ${stamp}`, 90, today);
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${under}, ${`Tarea ${stamp}`}, ${monthStart}::date, 15) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${under}, ${task.id}, ${monthStart}::date)
  `;
  // 432 of 720 is exactly 60 %: not under it.
  const exact = await seedGoal(exactName, 720);
  await quantity(exact, `Sesión C ${stamp}`, 432, monthStart);
  // A measure and facts, no amount this month.
  const bare = await seedGoal(bareName, null);
  await quantity(bare, `Sesión D ${stamp}`, 100, monthStart);

  const pace = `día ${Number(today.slice(8, 10))} · 6 h 30 min de 12 h, bajo el 60 %`;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const seen = (text: string) => page.getByText(text, { exact: true }).locator("visible=true");
    const lines = async (weekSays: number) => {
      await expect(page.locator("main")).toHaveCount(1);
      await expect(seen(underName).first()).toBeVisible();
      // From the 20th the under-60 goal's «de 12 h» sits inside its pace line.
      const inLine = late ? 1 : 0;
      await expect(seen("6 h 30 min")).toHaveCount(1 + weekSays);
      // On the 1st the exact goal's 432 minutes were done today: its done row says them too.
      await expect(seen("7 h 12 min")).toHaveCount(1 + weekSays + (today === monthStart ? 1 : 0));
      await expect(seen("de 12 h")).toHaveCount(2 - inLine);
      // From the 20th the under-60 goal says its pace and the 60 % one does not;
      // before it, neither does.
      if (late) await expect(seen(pace)).toHaveCount(1);
      // No percentage of its own: «60 %» is the only one on the screen.
      await expect(page.getByText(/\d+ %/).locator("visible=true").filter({ hasNotText: /60 %/ })).toHaveCount(0);
      await expect(page.getByText(/bajo el 60 %/).locator("visible=true")).toHaveCount(late ? 1 : 0);
    };

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await lines(0);
    await expect(seen("este mes")).toHaveCount(1);
    await expect(seen(bareName).first()).toBeVisible();
    // The goal with no amount is a row of the day, never a line of the block.
    await expect(page.getByText("de 12 h", { exact: true }).locator("visible=true")).toHaveCount(late ? 1 : 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    // The card keeps its week figure and now reads it in hours and minutes:
    // 90 this week, or the whole 390 in the first days of a month.
    const inWeek = weekOf(today).includes(monthStart);
    await lines(inWeek ? 1 : 0);
    if (!inWeek) {
      // Two honest places: the card's week figure and the done row's own line
      // «1 h 30 min · 19:52 · lo dijiste tú», a mono figure since 367.
      await expect(seen("1 h 30 min")).toHaveCount(2);
      await expect(seen("esta semana").locator("xpath=preceding-sibling::*[1]").filter({ hasText: /^1 h 30 min$/ })).toHaveCount(1);
    }

    // Never on a past day (the ended line's own guard).
    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(seen(underName).first()).toBeVisible();
    await expect(seen("de 12 h")).toHaveCount(0);
    await expect(seen("este mes")).toHaveCount(0);
    await expect(page.getByText(/bajo el 60 %/).locator("visible=true")).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

// `HoyTareaMes.dc.html` (RP-31): under «este mes» each goal's line
// is followed by its next task of the month, its estimate and a mark that
// completes it; the next one takes its place.
test("Hoy draws the goal's next task of the month under its line, completes it, and draws none on a past day", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const today = todayInZone();
  const monthStart = `${today.slice(0, 7)}-01`;
  const goalName = `Meta tarea ${stamp}`;
  const bareName = `Meta tarea sin monto ${stamp}`;
  const firstName = `Primera ${stamp}`;
  const secondName = `Segunda ${stamp}`;
  const bareTask = `Huérfana ${stamp}`;

  const seedGoal = async (name: string, budget: number | null) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${name}, ${plusDays(90)}, 'minutos', 'minutos', now() - interval '40 days')
      returning id
    `;
    if (budget !== null) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${monthStart}::date, ${budget})
      `;
    }
    return goal.id;
  };
  const task = (goalId: string, name: string, estimate: number) => db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${name}, ${monthStart}::date, ${estimate})
  `;

  const goalId = await seedGoal(goalName, 720);
  await task(goalId, firstName, 240);
  await task(goalId, secondName, 60);
  const bareId = await seedGoal(bareName, null);
  await task(bareId, bareTask, 30);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const mark = (name: string) =>
      page.getByRole("button", { name: `Marcar hecha: ${name}` }).locator("visible=true");
    // The task's own line: the mark's button, the name and the estimate at the end.
    const line = (name: string) => mark(name).locator("xpath=..");

    for (const size of [
      { width: 360, height: 740 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      await expect(mark(firstName)).toHaveCount(1);
      await expect(line(firstName).getByText(firstName, { exact: true })).toBeVisible();
      await expect(line(firstName).getByText("4 h", { exact: true })).toBeVisible();
      // Only the next one of the goal, never the second.
      await expect(mark(secondName)).toHaveCount(0);
      // A goal with tasks but no amount still has its line and next task.
      await expect(mark(bareTask)).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    }

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    const started = Date.now();
    await mark(firstName).click();
    await expect(mark(secondName)).toHaveCount(1, { timeout: 5000 });
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(mark(firstName)).toHaveCount(0);
    await expect(line(secondName).getByText("1 h", { exact: true })).toBeVisible();

    await mark(secondName).click();
    await expect(mark(secondName)).toHaveCount(0, { timeout: 5000 });
    // Only the amountless goal's own task is left.
    await expect(page.getByRole("button", { name: /^Marcar hecha: / })).toHaveCount(1);
    await expect(mark(bareTask)).toHaveCount(1);

    // Never on a past day.
    const [again] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goalId}, ${`Tercera ${stamp}`}, ${monthStart}::date, 240) returning id
    `;
    expect(again.id).toBeTruthy();
    await page.goto("/");
    await expect(mark(`Tercera ${stamp}`)).toHaveCount(1);
    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Marcar hecha: / })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

// RP-30 on Hoy's month line: a task that gained sub-tasks after the screen
// loaded is refused, and the refusal is said under the line, never swallowed.
test("Hoy says why a month task cannot be marked done when it gained sub-tasks meanwhile (RP-30)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const today = todayInZone();
  const monthStart = `${today.slice(0, 7)}-01`;
  const goalName = `Meta rechazo ${stamp}`;
  const taskName = `Con hijas ${stamp}`;

  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${goalName}, ${plusDays(90)}, 'minutos', 'minutos', now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${monthStart}::date, 720)
  `;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, ${taskName}, ${monthStart}::date, 60) returning id
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    const mark = page.getByRole("button", { name: `Marcar hecha: ${taskName}` }).locator("visible=true");
    await expect(mark).toHaveCount(1);
    const refusal = page.getByText("Esta tarea se da por hecha cuando lo están sus sub-tareas.");
    await expect(refusal).toHaveCount(0);

    await db`
      insert into goals.one_offs (user_id, goal_id, name, parent_id)
      values (${person.id}, ${goal.id}, ${`Hija ${stamp}`}, ${task.id})
    `;
    await mark.click();
    await expect(refusal.locator("visible=true")).toHaveCount(1);
    const facts = await db`select 1 from goals.facts where one_off_id = ${task.id}`;
    expect(facts.length).toBe(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
