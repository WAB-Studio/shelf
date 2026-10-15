import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";
import { boxOf } from "./box";
import { noonFromToday } from "./reloj";

// `HoyCuenta.dc.html`: Hoy counts «hechos N de M» over the rows
// the Semana counts, and a flexible met in its period stays as a quiet row.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("«hechos» moves as a row is tapped and matches the Semana's cell; a met flexible stays quiet and tappable; a flexible row fits at 360", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalName = `Meta cuenta ${stamp}`;
  const first = `Primero ${stamp}`;
  const second = `Segundo ${stamp}`;
  const partial = `Parcial ${stamp}`;
  const met = `Cumplida ${stamp}`;
  const metWeekly = `Cumplida semana ${stamp}`;
  const today = todayInZone();
  const week = weekOf(today);
  // A row is met by a fact earlier in its period. The 1st has no earlier day
  // in its month and a Monday none in its week: the fact is seeded yesterday,
  // which falls in the period before, so the row stays owed.
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const monthlyMet = firstOfMonth < today;
  const weeklyMet = week[0] < today;
  // The two fixed rows and the flexible with progress ask today (RP-01); a
  // flexible met in its period asks nothing and stays out of the count.
  const asked = 3 + (monthlyMet ? 0 : 1) + (weeklyMet ? 0 : 1);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${goalName}, ${plusDays(90)}, now() - interval '20 days') returning id
  `;
  const commitment = async (name: string, kind: string, count: number | null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
      values (${person.id}, ${goal.id}, ${name}, ${kind}, ${count}, 'tap', now() - interval '20 days')
      returning id
    `;
    return row.id;
  };
  await commitment(first, "daily", null);
  await commitment(second, "daily", null);
  await commitment(partial, "times_per_week", 3);
  const metId = await commitment(met, "times_per_month", 1);
  const metWeeklyId = await commitment(metWeekly, "times_per_week", 1);
  const fact = (id: string, day: string) => db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, written_at)
    values (${person.id}, ${id}, ${goal.id}, ${day}, now())
  `;
  await fact(metId, monthlyMet ? firstOfMonth : plusDays(-1));
  await fact(metWeeklyId, weeklyMet ? week[0] : plusDays(-1));
  // One-offs never count: two pending and one done leave «hechos» to the commitments.
  const oneOffIds: string[] = [];
  for (const suffix of ["a", "b", "c"]) {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, day)
      values (${person.id}, null, ${`Suelta ${suffix} ${stamp}`}, ${today}) returning id
    `;
    oneOffIds.push(row.id);
  }
  await db`
    insert into goals.facts (user_id, commitment_id, one_off_id, goal_id, day, written_at)
    values (${person.id}, null, ${oneOffIds[2]}, null, ${today}, now())
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("main").getByText(goalName, { exact: true })).toBeVisible();
    await expect(page.getByText(`hechos 0 de ${asked}`, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: new RegExp(`^${first}`) }).click();
    await expect(page.getByText(`hechos 1 de ${asked}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${second}`) }).click();
    await expect(page.getByText(`hechos 2 de ${asked}`, { exact: true })).toBeVisible();

    // A flexible with progress says only its progress, on one line.
    const partialRow = page.getByRole("button", { name: new RegExp(`^${partial}`) });
    await expect(partialRow).toContainText("0 de 3 esta semana");
    await expect(partialRow).not.toContainText("veces por semana");
    const box = await partialRow.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(72);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // The Semana's cell for today counts the same rows.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/semana");
    await expect(page.locator("main")).toHaveCount(1);
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    await expect(table.locator("tfoot td").nth(week.indexOf(today))).toHaveText(`2 de ${asked}`);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    const quiet = page.getByRole("button", { name: new RegExp(`^${met}`) });
    await expect(quiet).toContainText(monthlyMet ? "cumplida este mes · 1 de 1" : "0 de 1 este mes");
    await expect(page.getByText(`hechos 2 de ${asked}`, { exact: true })).toBeVisible();

    if (monthlyMet) {
      await quiet.click();
      await expect(quiet).toContainText("cumplida este mes · 2 veces");
      await expect(page.getByText(`hechos 2 de ${asked}`, { exact: true })).toBeVisible();
      const [{ count }] = await db<{ count: number }[]>`
        select count(*)::int as count from goals.facts where user_id = ${person.id} and day = ${today}
      `;
      // Three taps (two daily, one quiet flexible) plus the done one-off's fact.
      expect(count).toBe(4);

      await quiet.click();
      await expect(quiet).toContainText("cumplida este mes · 1 de 1");
    }

    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("button", { name: new RegExp(`^${metWeekly}`) })).toContainText(
      weeklyMet ? "cumplida esta semana · 1 de 1" : "0 de 1 esta semana",
    );
  } finally {
    await context.close();
    await db`delete from goals.facts where one_off_id in ${db(oneOffIds)}`;
    await db`delete from goals.one_offs where id in ${db(oneOffIds)}`;
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

test("an open goal that counts nothing draws no «hechos» line, and one counted row draws «hechos 0 de 1»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalName = `Meta una cuenta ${stamp}`;
  const row = `Única ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${goalName}, ${plusDays(90)}, now() - interval '20 days') returning id
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Hoy", exact: true })).toBeVisible();
    await expect(page.getByText(/hechos \d+ de \d+/)).toHaveCount(0);

    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, ${goal.id}, ${row}, 'daily', 'tap', now() - interval '20 days')
    `;
    await page.goto("/");
    await expect(page.getByRole("button", { name: new RegExp(`^${row}`) })).toBeVisible();
    await expect(page.getByText("hechos 0 de 1", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.commitments where goal_id = ${goal.id}`;
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

// Boards `HoyDia` and `HoyAyerPrimerDia`: Hoy counts every row that
// asks today, flexible and evidence rows included (RP-01), and the header's step
// back says «ayer» in a word, absent before the first day with a goal.

const THEME = /^Cambiar a modo (claro|oscuro)$/;

async function seedOwed(db: postgres.Sql, person: Person, goalName: string, createdAgo: string, evidenceLookups: number) {
  const stamp = Date.now();
  const deviceId = randomUUID();
  const today = todayInZone();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${goalName}, ${plusDays(90)}, now() - ${createdAgo}::interval) returning id
  `;
  const names = { fixedA: `Fija A ${stamp}`, fixedB: `Fija B ${stamp}`, fixedC: `Fija C ${stamp}`, flexible: `Flexible ${stamp}`, evidence: `Buscar ${stamp}` };
  const fixed = (name: string, kind: string, extra: number | null) => db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
    values (${person.id}, ${goal.id}, ${name}, ${kind}, ${extra}, 'tap', now() - ${createdAgo}::interval)
  `;
  await fixed(names.fixedA, "daily", null);
  await fixed(names.fixedB, "daily", null);
  await fixed(names.fixedC, "daily", null);
  await fixed(names.flexible, "times_per_week", 3);
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
    values (
      ${person.id}, ${goal.id}, ${names.evidence}, 'daily', 'evidence',
      (select id from goals.evidence_sources where key = 'reading_lookups'), 1,
      now() - ${createdAgo}::interval
    )
  `;
  for (let local = 1; local <= evidenceLookups; local++) {
    await db`insert into reading.lookups
      (user_id, device_id, local_id, at, text, normalised, kind, outcome, headword, rule, senses, translation, dictionary_ready, origin, record_schema)
      values (${person.id}, ${deviceId}, ${local}, ${new Date(`${today}T23:30:00-05:00`)}, 'evidencia', 'evidencia', 'word', 'miss', null, null, 0, null, true, null, 2)`;
  }
  return { goalId: goal.id, deviceId, names };
}

async function cleanOwed(db: postgres.Sql, person: Person, seeded: { goalId: string; deviceId: string }) {
  await db`delete from reading.lookups where user_id = ${person.id} and device_id = ${seeded.deviceId}`;
  await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
}

async function onPhone(browser: import("@playwright/test").Browser, person: Person, width: number) {
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 800 }, hasTouch: true });
  return { context, page: await context.newPage() };
}

async function todayCell(page: Page, index: number): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/semana");
  await expect(page.locator("main")).toHaveCount(1);
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  return (await table.locator("tfoot td").nth(index).textContent())!.trim();
}

test("three fixed, one flexible and one evidence row, nothing done, read «hechos 0 de 5»; the Semana's cell for today says the same (RP-01)", async ({
  person,
  browser,
  db,
}) => {
  const seeded = await seedOwed(db, person, `Meta cuenta cinco ${Date.now()}`, "20 days", 0);
  const { context, page } = await onPhone(browser, person, 360);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("button", { name: new RegExp(`^${seeded.names.flexible}`) })).toBeVisible();
    await expect(page.getByText("hechos 0 de 5", { exact: true })).toBeVisible();

    expect(await todayCell(page, weekOf(todayInZone()).indexOf(todayInZone()))).toBe("0 de 5");
  } finally {
    await context.close();
    await cleanOwed(db, person, seeded);
  }
});

test("the evidence row met by its source moves the count to «hechos 1 de 5», on Hoy and in the Semana's cell (RP-01, RP-09)", async ({
  person,
  browser,
  db,
}) => {
  const seeded = await seedOwed(db, person, `Meta cuenta evidencia ${Date.now()}`, "20 days", 1);
  const { context, page } = await onPhone(browser, person, 360);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("hechos 1 de 5", { exact: true })).toBeVisible();

    expect(await todayCell(page, weekOf(todayInZone()).indexOf(todayInZone()))).toBe("1 de 5");
  } finally {
    await context.close();
    await cleanOwed(db, person, seeded);
  }
});

for (const width of [360, 1440]) {
  test(`at ${width} the header's step back reads «ayer» in a word and goes to yesterday's day`, async ({ person, browser, db }) => {
    const seeded = await seedOwed(db, person, `Meta ayer ${Date.now()}`, "20 days", 0);
    const { context, page } = await onPhone(browser, person, width);
    try {
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const yesterday = plusDays(-1);
      const link = page.locator(`main a[href="/dia/${yesterday}"]`);
      await expect(link).toHaveCount(1);
      await expect(link).toBeVisible();
      await expect(link).toHaveText("ayer");
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/dia/${yesterday}$`));
    } finally {
      await context.close();
      await cleanOwed(db, person, seeded);
    }
  });
}

// The widest date the app can draw, so the line is measured whatever day the suite runs.
const LONGEST_DATE = "miércoles 30 de septiembre";

for (const longest of [false, true]) {
test(`at 360 the header holds eyebrow, «Hoy», the count, «ayer» and the theme button without overflow (${longest ? "the longest date" : "today's date"})`, async ({
  person,
  browser,
  db,
}) => {
  const seeded = await seedOwed(db, person, `Meta cabecera ${Date.now()}`, "20 days", 0);
  const { context, page } = await onPhone(browser, person, 360);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    const h1 = page.getByRole("heading", { name: "Hoy", exact: true, level: 1 });
    const count = page.getByText("hechos 0 de 5", { exact: true });
    const link = page.locator(`main a[href="/dia/${plusDays(-1)}"]`);
    const theme = page.getByRole("button", { name: THEME });
    await expect(link).toHaveText("ayer");
    const eyebrow = page.locator("main > header:visible").getByText(/^[a-zñáéíóú]+ \d{1,2} de [a-zñ]+$/).first();
    if (longest) await eyebrow.evaluate((node, text) => void (node.textContent = text), LONGEST_DATE);
    const boxes = {
      eyebrow: (await boxOf(eyebrow)),
      h1: (await boxOf(h1)),
      count: (await boxOf(count)),
      link: (await boxOf(link)),
      theme: (await boxOf(theme)),
    };
    for (const [name, box] of Object.entries(boxes)) {
      expect(box.x, `${name} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(360);
    }
    expect(boxes.link.x).toBeGreaterThanOrEqual(boxes.h1.x + boxes.h1.width);
    expect(boxes.link.x + boxes.link.width).toBeLessThanOrEqual(boxes.theme.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    // Date and controls share the header's first line: «ayer» and the toggle stand at its end.
    expect(boxes.link.x).toBeGreaterThanOrEqual(boxes.eyebrow.x + boxes.eyebrow.width);
    expect(Math.abs(boxes.link.y + boxes.link.height / 2 - (boxes.eyebrow.y + boxes.eyebrow.height / 2))).toBeLessThan(12);
  } finally {
    await context.close();
    await cleanOwed(db, person, seeded);
  }
});
}

test("a person whose first goal opened today reads «hechos 0 de 3» and no link to yesterday; opened yesterday, the link stays (RP-01)", async ({
  person,
  browser,
  db,
}) => {
  // The fixture clears the worker's person before each test: the goal made here is the first it ever had.
  const seeded = await seedOwed(db, person, `Meta primer día ${Date.now()}`, "0 seconds", 0);
  await db`delete from goals.commitments where goal_id = ${seeded.goalId} and name in (${seeded.names.fixedC}, ${seeded.names.flexible})`;
  await db`update goals.goals set created_at = ${noonFromToday(0)} where id = ${seeded.goalId}`;
  await db`update goals.commitments set created_at = ${noonFromToday(0)} where goal_id = ${seeded.goalId}`;
  const { context, page } = await onPhone(browser, person, 360);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("hechos 0 de 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hoy", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: THEME })).toBeVisible();
    await expect(page.locator('main a[href^="/dia/"]')).toHaveCount(0);
    await expect(page.getByText("ayer", { exact: true })).toHaveCount(0);

    await db`update goals.goals set created_at = ${noonFromToday(-1)} where id = ${seeded.goalId}`;
    await db`update goals.commitments set created_at = ${noonFromToday(-1)} where goal_id = ${seeded.goalId}`;
    await page.goto("/");
    await expect(page.locator(`main a[href="/dia/${plusDays(-1)}"]`)).toHaveText("ayer");
  } finally {
    await context.close();
    await cleanOwed(db, person, seeded);
  }
});

test("a person with no goal reads the empty day with no link to yesterday (RP-01)", async ({ person, browser }) => {
  const { context, page } = await onPhone(browser, person, 360);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("Todavía no hay nada que anotar.")).toBeVisible();
    await expect(page.locator('main a[href^="/dia/"]')).toHaveCount(0);
    await expect(page.getByText("ayer", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
