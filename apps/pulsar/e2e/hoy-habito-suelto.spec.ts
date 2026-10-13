import { test, expect, visit } from "./fixtures";
import {
  TODAY,
  TODAY_INDEX,
  drawn,
  seedGoal,
  seedHabit,
  seedTap,
  shift,
} from "./sin-final-seed";

// `HoyHabitoSuelto`, `HoySinFinal` (RP-99, RP-100; decisions of 2026-10-13): Hoy draws a goal with no end without a word
// about its end, and a habit with no goal in its own group, «Hábitos» (never «Sin meta»: DESIGN.md wins over the
// board's note), after the goals. A person with only habits is not the empty day. Runs any day of the week:
// every date is read from the day the app reads.

const EMPTY = "Todavía no hay nada que anotar.";
const FACES = [360, 1280];
const GROUP = "hábitos";

const mainText = async (page: import("@playwright/test").Page) =>
  drawn(await page.locator("main").innerText());

for (const width of FACES) {
  test(`at ${width} a habit with no goal is drawn in the «Hábitos» group, after the goals and under none of them`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: drawing only `goals.map` (the habit never appears), or a group labelled «Sin meta».
    const stamp = Date.now();
    const goalName = `Cuidado ${stamp}`;
    const kept = `Bañarse ${stamp}`;
    const water = `Tomar agua ${stamp}`;
    const stretch = `Estirar ${stamp}`;
    const goalId = await seedGoal(db, person.id, goalName, { horizon: shift(TODAY, 60) });
    await seedTap(db, person.id, goalId, kept);
    await seedHabit(db, person.id, water, { kind: "daily" }, { kind: "quantity", target: 2, unit: "litros" });
    await seedHabit(db, person.id, stretch, { kind: "daily" });
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await visit(page, "/");
      const text = await mainText(page);
      const group = text.indexOf(GROUP);
      expect(group, "the «Hábitos» group is drawn").toBeGreaterThanOrEqual(0);
      expect(text.indexOf(goalName.toLowerCase())).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(kept.toLowerCase())).toBeGreaterThan(text.indexOf(goalName.toLowerCase()));
      // After the last goal's commitment; both habits below the label.
      expect(group).toBeGreaterThan(text.indexOf(kept.toLowerCase()));
      expect(text.indexOf(water.toLowerCase())).toBeGreaterThan(group);
      expect(text.indexOf(stretch.toLowerCase())).toBeGreaterThan(group);
      expect(text, "the group is «Hábitos», never «Sin meta»").not.toContain("sin meta");
      // The group has no month line and no phase: nothing of a goal after its label.
      const below = text.slice(group);
      expect(below).not.toContain("este mes");
      expect(below).not.toContain("fase");
      expect(below).toContain("todos los días · 2 litros");
      await expect(page.getByRole("button", { name: new RegExp(`^${water}`) })).toBeVisible();
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
    }
  });

  test(`at ${width} a person with only habits and no goal reads the group, not the empty day, and the count holds the habits`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: `goals.length === 0` deciding the empty day.
    const stamp = Date.now();
    const names = ["Tomar agua", "Estirar", "Llamar"].map((name) => `${name} ${stamp}`);
    for (const name of names) await seedHabit(db, person.id, name, { kind: "daily" });
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await visit(page, "/");
      await expect(page.getByText(EMPTY)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Abrir una meta" })).toHaveCount(0);
      for (const name of names) await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
      expect(await mainText(page)).toContain(GROUP);
      await expect(page.getByText("hechos 0 de 3", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test("control: a person whose only habit was retired still reads the empty day, word for word", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: a loose-habit list that ignores `retired_at` (the habit comes back and the empty day is lost).
  const id = await seedHabit(db, person.id, `Retirado ${Date.now()}`, { kind: "daily" });
  await db`update goals.commitments set retired_at = now() - interval '1 day' where id = ${id}`;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 800 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    await expect(page.getByText(EMPTY)).toBeVisible();
    await expect(page.getByRole("link", { name: "Abrir una meta" })).toHaveAttribute("href", "/metas/nueva");
    await expect(page.getByRole("link", { name: "Importar un plan" })).toHaveAttribute("href", "/metas/importar");
    expect(await mainText(page)).not.toContain(GROUP);
  } finally {
    await context.close();
  }
});

test("a loose tap habit is one tap to done, writes a fact with no goal, and the second tap undoes it", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: a route that demands `goalId` (the tap fails, no fact), or an undo that leaves the fact.
  const name = `Estirar ${Date.now()}`;
  const id = await seedHabit(db, person.id, name, { kind: "daily" });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 800 },
  });
  const facts = () =>
    db<{ goal_id: string | null; user_id: string }[]>`
      select goal_id, user_id from goals.facts where commitment_id = ${id} and day = ${TODAY}::date
    `;
  try {
    const page = await context.newPage();
    await visit(page, "/");
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(page.getByText("hechos 0 de 1", { exact: true })).toBeVisible();

    await row.click();
    await expect(row.locator("svg")).toBeVisible();
    await expect(page.getByText("hechos 1 de 1", { exact: true })).toBeVisible();
    await expect.poll(async () => (await facts()).length).toBe(1);
    const [fact] = await facts();
    expect(fact.goal_id).toBeNull();
    expect(fact.user_id).toBe(person.id);

    await row.click();
    await expect(row.locator("svg")).toHaveCount(0);
    await expect(page.getByText("hechos 0 de 1", { exact: true })).toBeVisible();
    await expect.poll(async () => (await facts()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test("a loose quantity habit opens its sheet with its own unit and the number picked is what is written", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: a sheet that takes the unit from the goal (a habit has none: no «litros»), or one that writes the plan's target (2).
  const name = `Tomar agua ${Date.now()}`;
  const id = await seedHabit(db, person.id, name, { kind: "daily" }, { kind: "quantity", target: 2, unit: "litros" });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 800 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("¿Cuánto hiciste hoy?")).toBeVisible();
    await expect(sheet.getByText("litros", { exact: true })).toBeVisible();
    for (const chip of ["1", "2", "3", "4"]) await expect(sheet.getByRole("button", { name: chip, exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "3", exact: true }).click();
    await sheet.getByRole("button", { name: "Anotar" }).click();
    await expect(sheet).toBeHidden();

    await expect
      .poll(async () => {
        const rows = await db<{ quantity: number | null; goal_id: string | null }[]>`
          select quantity, goal_id from goals.facts where commitment_id = ${id} and day = ${TODAY}::date
        `;
        return rows.map((row) => [row.quantity, row.goal_id]);
      })
      .toEqual([[3, null]]);
  } finally {
    await context.close();
  }
});

test("«hechos N de M» of Hoy counts the habits and is the number Semana shows for today", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: tallying only the slots of a goal (Hoy would read «de 1» and drift from Semana).
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta cuenta ${stamp}`, { horizon: shift(TODAY, 60) });
  await seedTap(db, person.id, goalId, `De la meta ${stamp}`);
  const water = `Tomar agua ${stamp}`;
  await seedHabit(db, person.id, water, { kind: "daily" });
  await seedHabit(db, person.id, `Estirar ${stamp}`, { kind: "daily" });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 800 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    await expect(page.getByRole("button", { name: new RegExp(`^${water}`) })).toBeVisible();
    await expect(page.getByText("hechos 0 de 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${water}`) }).click();
    await expect(page.getByText("hechos 1 de 3", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await visit(page, "/semana");
    await expect(page.getByRole("table").locator("tfoot td").nth(TODAY_INDEX)).toHaveText("1 de 3");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

for (const width of FACES) {
  test(`at ${width} a goal with no end reads its group and month line and nothing of an end`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: `dayBefore(null)` / `horizon <= today` with null (a «terminó …» or «última semana» line, or a crash).
    const stamp = Date.now();
    const name = `Leer ${stamp}`;
    const goalId = await seedGoal(db, person.id, name, { unit: "minutos", budget: 480 });
    await seedTap(db, person.id, goalId, `Leer diez ${stamp}`);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await visit(page, "/");
      const text = await mainText(page);
      expect(text).toContain(name.toLowerCase());
      expect(text).toContain(`leer diez ${stamp}`);
      // The month line is the usual one («este mes … de 8 h»).
      expect(text).toContain("este mes");
      expect(text).toContain("de 8 h");
      expect(text).not.toContain("terminó");
      expect(text).not.toContain("última semana");
      expect(text).not.toMatch(/semana \d+ de \d+/);
      expect(text).not.toContain("fase");
      expect(text).not.toContain("1969");
      expect(text).not.toContain("1970");
      await expect(page.getByText(EMPTY)).toHaveCount(0);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
    }
  });
}

test("control: a goal with a distant end draws the same day, with the same month line", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Not a kill: it holds the assertions of the test above to what Hoy draws for a goal that has an end.
  const stamp = Date.now();
  const name = `Leer ${stamp}`;
  const goalId = await seedGoal(db, person.id, name, { horizon: shift(TODAY, 120), unit: "minutos", budget: 480 });
  await seedTap(db, person.id, goalId, `Leer diez ${stamp}`);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    const text = await mainText(page);
    expect(text).toContain("este mes");
    expect(text).toContain("de 8 h");
    expect(text).not.toContain("terminó");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
