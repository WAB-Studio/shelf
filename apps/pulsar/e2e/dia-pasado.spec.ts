import type postgres from "postgres";

import { test, expect, visit } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// RP-06's own screen (`DiaPasado.dc.html`): a day already past, reached by a
// step back from Hoy. Each test seeds its own goal and commitment straight
// into the database — backdated, since `declareFact` refuses a day before a
// commitment existed — and drops the goal by the id it got back.
// Paths by day: none; «empezó el» names a day inside the seven back, in any week.

// Seven, as `PAST_DAY_LIMIT` (`lib/validation/fact.ts`) says: typed again
// here on purpose, so a limit changed there is a limit this spec notices.
const LIMIT = 7;

// «Yesterday» is today minus one civil day in the person's zone, whatever
// week it falls in: on a Monday it is last week's Sunday (`docs/TRAPS.md`,
// the Monday entry), and nothing here reads a week, so that day is as good
// as any other.
function pastDay(daysAgo: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return dateToCivilDate(date);
}

// ICU's Spanish weekday, never the catalogue's list the screen reads.
function writtenLabel(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `anotado el ${weekday} ${date.getUTCDate()}`;
}

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  commitment: { name: string; kind: "tap" } | { name: string; kind: "quantity"; target: number; unit: string },
): Promise<{ goalId: string; commitmentId: string }> {
  const stamp = Date.now();
  // The goal opens before the commitment it backdates: a day before its goal
  // is not drawn (RNP-07).
  const createdAt = new Date(Date.now() - (LIMIT + 3) * 86_400_000);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (
      ${personId}, ${`Meta día pasado ${stamp}`}, ${pastDay(-60)},
      ${new Date(createdAt.getTime() - 86_400_000)}
    ) returning id
  `;
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (
      ${personId}, ${goal.id}, ${commitment.name}, 'daily', ${commitment.kind},
      ${commitment.kind === "quantity" ? commitment.target : null},
      ${commitment.kind === "quantity" ? commitment.unit : null},
      ${createdAt}
    ) returning id
  `;
  return { goalId: goal.id, commitmentId: row.id };
}

async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

async function factsFor(db: postgres.Sql, commitmentId: string) {
  return db<{ day: string; quantity: number | null }[]>`
    select day::text as day, quantity from goals.facts where commitment_id = ${commitmentId}
  `;
}

test("from Hoy, steps back reach yesterday and then the seventh day back, and no eighth step is drawn (RP-06)", async ({
  person,
  browser,
  db,
}) => {
  // «ayer» is drawn only from the first day with a goal: this person's opened before the seven days back.
  const { goalId } = await seedGoal(db, person.id, { name: `Fila ayer ${Date.now()}`, kind: "tap" });
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await stepBack(page);
  } finally {
    await context.close();
    await deleteGoal(db, person.id, goalId);
  }
});

async function stepBack(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "ayer", exact: true }).click();
  await page.waitForURL(`**/dia/${pastDay(1)}`);
  await expect(page.getByRole("link", { name: "volver a hoy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Semana" })).toHaveAttribute("aria-current", "page");

  for (let back = 2; back <= LIMIT; back++) {
    await page.getByRole("link", { name: "día anterior" }).click();
    await page.waitForURL(`**/dia/${pastDay(back)}`);
  }

  await expect(page.getByRole("link", { name: "volver a hoy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "día anterior" })).toHaveCount(0);

  await page.getByRole("link", { name: "volver a hoy" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

test("on yesterday a tap writes one fact for yesterday, read as written today; Hoy is untouched; a second tap undoes it (RP-06, RP-05)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Compromiso día pasado ${Date.now()}`;
  const { goalId, commitmentId } = await seedGoal(db, personId, { name, kind: "tap" });
  const yesterday = pastDay(1);

  try {
    await page.goto(`/dia/${yesterday}`);
    const row = page.locator("button", { hasText: name });
    await expect(row.locator("svg")).toHaveCount(0);

    await row.click();
    await expect(row.locator("svg")).toBeVisible();
    await expect(row).toContainText(writtenLabel(todayInZone()));
    expect(await factsFor(db, commitmentId)).toEqual([{ day: yesterday, quantity: null }]);

    await page.goto("/");
    const todayRow = page.locator("button", { hasText: name });
    await expect(todayRow).toBeVisible();
    await expect(todayRow.locator("svg")).toHaveCount(0);
    await expect(todayRow).not.toContainText("anotado");

    await page.goto(`/dia/${yesterday}`);
    await expect(row.locator("svg")).toBeVisible();
    await row.click();
    await expect(row.locator("svg")).toHaveCount(0);
    await expect(row).not.toContainText("anotado");
    await expect.poll(() => factsFor(db, commitmentId).then((rows) => rows.length)).toBe(0);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a quantity row on a past day asks for that day and writes its number there (RP-03, RP-06)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Cantidad día pasado ${Date.now()}`;
  const { goalId, commitmentId } = await seedGoal(db, personId, {
    name,
    kind: "quantity",
    target: 10,
    unit: "minutos",
  });
  const day = pastDay(3);

  try {
    await page.goto(`/dia/${day}`);
    await page.locator("button", { hasText: name }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("¿Cuánto hiciste ese día?");
    await sheet.getByRole("button", { name: "Anotar" }).click();
    await expect(sheet).toBeHidden();

    expect(await factsFor(db, commitmentId)).toEqual([{ day, quantity: 10 }]);
    await expect(page.locator("button", { hasText: name })).toContainText(
      new RegExp(`10 min · \\d{2}:\\d{2} · lo dijiste tú · ${writtenLabel(todayInZone())}`),
    );
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a past day draws no one-offs and no field, and holds at 360px (RP-06, RP-19, RNP-07)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta vista desde ayer ${Date.now()}`;
  const { goalId } = await seedGoal(db, personId, { name: `Compromiso ${name}`, kind: "tap" });
  const [oneOff] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day)
    values (${personId}, ${name}, ${pastDay(2)}) returning id
  `;

  try {
    await page.goto(`/dia/${pastDay(1)}`);
    await expect(page.getByRole("link", { name: "volver a hoy" })).toBeVisible();
    await expect(page.getByText(/hechos \d+ de \d+/).first()).toBeVisible();
    await expect(page.getByRole("main").getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Algo suelto")).toHaveCount(0);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await page.screenshot({ path: "private/dia-pasado-360.png", fullPage: true });
  } finally {
    await db`delete from goals.one_offs where id = ${oneOff.id}`;
    await deleteGoal(db, personId, goalId);
  }
});

test("a commitment created today and a goal opened today are absent from yesterday (RNP-07)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const goalName = `Meta recién abierta ${stamp}`;
  const commitmentName = `Compromiso recién nacido ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${goalName}, ${pastDay(-60)}) returning id
  `;

  try {
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${personId}, ${goal.id}, ${commitmentName}, 'daily', 'tap')
    `;

    await page.goto("/");
    await expect(page.getByRole("main").getByText(goalName, { exact: true })).toBeVisible();
    await expect(page.locator("button", { hasText: commitmentName })).toBeVisible();

    await page.goto(`/dia/${pastDay(1)}`);
    await expect(page.getByRole("link", { name: "volver a hoy" })).toBeVisible();
    await expect(page.getByRole("main").getByText(goalName, { exact: true })).toHaveCount(0);
    await expect(page.locator("button", { hasText: commitmentName })).toHaveCount(0);
  } finally {
    await deleteGoal(db, personId, goal.id);
  }
});

test("a day before every goal this person holds says it asked for nothing, with no way to create one (RNP-07)", async ({
  person,
  browser,
  db,
}) => {
  const day = pastDay(LIMIT);
  const opened = pastDay(LIMIT - 2);
  const stamp = Date.now();
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(civilDateToDate(opened));
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    // Opened after `day`, so the day before it draws the line naming it.
    await db`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Tardía ${stamp}`}, ${pastDay(-60)}, ${new Date(`${opened}T17:00:00Z`)})
    `;
    const page = await context.newPage();
    await page.goto(`/dia/${day}`);
    await expect(page.getByText("Ese día no pedía nada")).toBeVisible();
    await expect(page.getByRole("link", { name: "Abrir una meta" })).toHaveCount(0);
    await expect(page.getByText(/hechos \d+ de \d+/)).toHaveCount(0);
    await expect(page.getByText(`tardía ${stamp} empezó el ${weekday} ${civilDateToDate(opened).getUTCDate()}`)).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("at 1440 an empty past day keeps its line in the column, under its title (RP-44)", async ({ person, browser, db }) => {
  const day = pastDay(LIMIT);
  const opened = pastDay(LIMIT - 2);
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    await db`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Tardía ${stamp}`}, ${pastDay(-60)}, ${new Date(`${opened}T17:00:00Z`)})
    `;
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await visit(page, `/dia/${day}`);
    const title = (await boxOf(page.getByText("Ese día no pedía nada")));
    const line = (await boxOf(page.getByText(/^tardía \d+ empezó el /i)));
    expect(Math.abs(line.x - title.x)).toBeLessThanOrEqual(1);
    expect(line.y).toBeGreaterThan(title.y);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("the seventh day back draws why there is no step further, the sixth draws the step (RP-06)", async ({
  page,
}) => {
  const reason = "Siete días atrás es lo más lejos que se anota.";

  await page.goto(`/dia/${pastDay(LIMIT)}`);
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByRole("link", { name: "día anterior" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.goto(`/dia/${pastDay(LIMIT - 1)}`);
  await expect(page.getByRole("link", { name: "día anterior" })).toBeVisible();
  await expect(page.getByText(reason)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

// Asserted by the not-found's heading, never by its status (`docs/TRAPS.md`):
// an error boundary would draw no day either.
for (const [label, fecha] of [
  ["tomorrow", pastDay(-1)],
  ["a word", "banana"],
  ["a day that does not exist", "2026-02-31"],
] as const) {
  test(`/dia/<${label}> draws no day (RP-06)`, async ({ page }) => {
    await page.goto(`/dia/${fecha}`);
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
    await expect(page.getByText(/hechos \d+ de \d+/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "volver a hoy" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Ver (ayer|el día anterior)/ })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/dia/${fecha}`);
  });
}

test("/dia/<the eighth day back> lands on its own week, not on a 404 (RP-06, RP-44)", async ({ page }) => {
  const day = pastDay(LIMIT + 1);
  await page.goto(`/dia/${day}`);
  await page.waitForURL((url) => url.pathname === "/semana" && url.searchParams.get("semana") === day);
  await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
});

test("a past day steps both ways: the day after, Hoy from yesterday, and no empty section (RP-06)", async ({
  person,
  browser,
  db,
}) => {
  const empty = `Meta sin filas ${Date.now()}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${empty}, ${pastDay(-60)}, ${new Date(Date.now() - (LIMIT + 3) * 86_400_000)})
    returning id
  `;
  // «Ese día no pedía nada» is an absence over the whole page: the person is the worker's own.
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.goto(`/dia/${pastDay(1)}`);
    await expect(page.getByRole("link", { name: "día siguiente" })).toHaveAttribute("href", "/");
    await expect(page.getByRole("link", { name: "día anterior" })).toHaveAttribute("href", `/dia/${pastDay(2)}`);

    await page.goto(`/dia/${pastDay(3)}`);
    await expect(page.getByRole("link", { name: "día siguiente" })).toHaveAttribute("href", `/dia/${pastDay(2)}`);
    await page.getByRole("link", { name: "día siguiente" }).click();
    await page.waitForURL(`**/dia/${pastDay(2)}`);

    // A goal open that day with nothing asked has no label of its own.
    // With no goal asking, the only thing under the header is the line.
    await expect(page.getByRole("main").getByText(empty)).toHaveCount(0);
    await expect(page.getByText("Ese día no pedía nada")).toBeVisible();
  } finally {
    await context.close();
    await deleteGoal(db, person.id, goal.id);
  }
});

test("a past day draws the half mark, «ese día pedía» and the count with «en parte» (RP-16, RP-06)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Parcial día pasado ${Date.now()}`;
  const { goalId, commitmentId } = await seedGoal(db, personId, { name, kind: "quantity", target: 3, unit: "min" });
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${personId}, ${goalId}, ${commitmentId}, ${pastDay(2)}::date, 2)
  `;
  try {
    await page.goto(`/dia/${pastDay(2)}`);
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(row).toContainText(/2 de 3 min · \d\d:\d\d · lo dijiste tú/);
    await expect(row.locator("[data-state]")).toHaveAttribute("data-state", "partial");
    await expect(page.getByText(/^hechos \d+ de \d+ · 1 en parte$/)).toBeVisible();
    await expect(page.getByText(/Meta día pasado \d+ · ese día pedía uno/)).toBeVisible();
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("/dia/<today> is Hoy itself (RP-06)", async ({ person, browser, db }) => {
  const { goalId } = await seedGoal(db, person.id, { name: `Fila hoy ${Date.now()}`, kind: "tap" });
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.goto(`/dia/${todayInZone()}`);
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByRole("link", { name: "ayer", exact: true })).toBeVisible();
  } finally {
    await context.close();
    await deleteGoal(db, person.id, goalId);
  }
});

// `DiaPasadoEscritorio.dc.html`: the date is the one `h1`, «volver a hoy» is the
// way back, and from 1024 the goals share the width the rail leaves in equal
// columns, so no section narrows as the screen widens. Three goals, each its
// own section, so a layout with an aside would push one of them into it.
for (const width of [360, 390, 1280, 1440]) {
  test(`at ${width} a past day has one h1, its way back lands on Hoy and its columns hold (RP-06, RNP-16)`, async ({
    person,
    browser,
    db,
  }) => {
    const stamp = Date.now();
    const names = [`Uno ${stamp}`, `Dos ${stamp}`, `Tres ${stamp}`];
    for (const name of names) await seedGoal(db, person.id, { name, kind: "tap" });
    const context = await browser.newContext({ storageState: person.sessionFile });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/dia/${pastDay(1)}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      const date = civilDateToDate(pastDay(1));
      const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(`${weekday} ${date.getUTCDate()}`);

      if (width >= 1024) {
        const boxes = async () => {
          const out: { x: number; y: number; width: number }[] = [];
          for (const name of names) {
            const box = await page.locator("main section").filter({ hasText: name }).boundingBox();
            if (!box) throw new Error(`no section for ${name}`);
            out.push(box);
          }
          return out;
        };
        const wide = await boxes();
        // The first two goals share a row: side by side, never stacked.
        expect(Math.abs(wide[0].y - wide[1].y)).toBeLessThanOrEqual(2);
        expect(wide[1].x).toBeGreaterThan(wide[0].x + wide[0].width);
        // Equal columns.
        for (const box of wide) expect(Math.abs(box.width - wide[0].width)).toBeLessThanOrEqual(2);

        await page.setViewportSize({ width: 1024, height: 900 });
        const atLimit = await boxes();
        // Each goal, by name, at least as wide as at 1024.
        wide.forEach((box, index) => {
          expect(box.width).toBeGreaterThanOrEqual(atLimit[index].width - 1);
        });
        await page.setViewportSize({ width, height: 900 });
      }

      await page.getByRole("link", { name: "volver a hoy" }).click();
      await page.waitForURL((url) => url.pathname === "/");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}
