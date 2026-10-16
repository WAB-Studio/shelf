import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import oneOffs from "../messages/es/oneOffs.json";

// `/sueltas` holds the one-offs dated after today under «programadas»: each
// is moved, done or deleted from there, and a done one says where it went
// (`SueltasProgramadas.dc.html`, `SueltaMover.dc.html`; RP-59, RP-22, RNP-07).
// Paths by day: tomorrow reads weekday and day with no month Monday to Saturday;
// on a Sunday it falls in next week and reads its month.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seed(
  db: postgres.Sql,
  personId: string,
  name: string,
  day: string | null,
  goalId?: string,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day, goal_id)
    values (${personId}, ${name}, ${day}, ${goalId ?? null}) returning id
  `;
  return row.id;
}

// A person of this spec's own: the group label counts every waiting one-off,
// so only a fresh identity can promise the count. Minted at a disposable lane
// (offset from `sueltas.spec.ts`) and registered under the suite's run, whose
// teardown drops it.
const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function words(day: string): string {
  const date = civilDateToDate(day);
  return `${WEEKDAYS[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()}`;
}

test("a one-off for tomorrow is listed under «programadas» with tomorrow's words, its goal as written (RP-59, RNP-07)", async ({
  person,
  browser,
  db,
}) => {
  const personId = person.id;
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  const name = `Programada de mañana ${stamp}`;
  const goalName = `Inglés ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${goalName}, ${plusDays(90)}) returning id
  `;
  const oneOffId = await seed(db, personId, name, plusDays(1), goal.id);

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/sueltas");

    await expect(page.getByText("Lo que espera", { exact: true })).toBeVisible();
    await expect(page.getByText(oneOffs.scheduledGroupOne, { exact: true })).toBeVisible();
    await expect(page.getByText(/sin día$/)).toHaveCount(0);
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(row).toContainText(`${words(plusDays(1))}`);
    await expect(row).toContainText(`de ${goalName}`);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Hoy" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where id = ${oneOffId}`;
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
  }
});

test("moved to today it leaves the list and draws on Hoy; moved to another day it reads the new one (RP-59)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Programada a mover ${Date.now()}`;
  const oneOffId = await seed(db, personId, name, plusDays(3));

  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Darle un día" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(`ahora: ${words(plusDays(3))}`);
    await expect(sheet.getByRole("radio", { name: "sin día" })).toHaveCount(0);

    await sheet.getByRole("radio", { name: "otro día" }).click();
    await sheet.getByLabel("qué día").fill(plusDays(5));
    await sheet.getByRole("button", { name: "Moverla" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toContainText(
      words(plusDays(5)),
    );

    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Darle un día" }).click();
    await page.getByRole("dialog").getByRole("radio", { name: "hoy" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Moverla" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveCount(0);

    await page.goto("/");
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

test("a past day is refused in the move sheet and the one-off stays where it was (RP-59)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Programada sin pasado ${Date.now()}`;
  const oneOffId = await seed(db, personId, name, plusDays(2));

  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Darle un día" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("qué día").fill(plusDays(-1));
    await sheet.getByRole("button", { name: "Moverla" }).click();

    await expect(sheet).toContainText("Ese día ya pasó");
    const [row] = await db<{ day: string }[]>`select day::text as day from goals.one_offs where id = ${oneOffId}`;
    expect(row.day).toBe(plusDays(2));
    await sheet.getByRole("button", { name: "Dejarla como está" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

test("done from the list it leaves, the status line survives and Hoy holds it in «hechas hoy» (RP-59, RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Programada hecha ${Date.now()}`;
  const oneOffId = await seed(db, personId, name, plusDays(2));

  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name: `Dar por hecha: ${name}` }).click();

    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveCount(0);
    const status = page.getByRole("status");
    await expect(status).toContainText(`«${name}» quedó en «hechas hoy».`);
    expect(await status.locator("p").evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
    await status.getByRole("link", { name: "ver hoy" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

test("a dayless one done from the list shows the same line (RP-59)", async ({ page, db, personId }) => {
  const name = `Suelta hecha con línea ${Date.now()}`;
  const oneOffId = await seed(db, personId, name, null);

  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name: `Dar por hecha: ${name}` }).click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`«${name}» quedó en «hechas hoy».`);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

test("deleted from the suelta's sheet its row is gone from the database (RP-22)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Programada a borrar ${Date.now()}`;
  const oneOffId = await seed(db, personId, name, plusDays(4));

  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Borrar la tarea" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("¿Borrarla?");
    await sheet.getByRole("button", { name: "Borrarla" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveCount(0);
    const rows = await db`select id from goals.one_offs where id = ${oneOffId}`;
    expect(rows).toHaveLength(0);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

test("the scheduled list reads in day order, whatever order the one-offs were made in (RP-59)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  // Made latest-day first: creation order is the reverse of day order.
  const late = await seed(db, person.id, `Orden tarde ${stamp}`, plusDays(9));
  const early = await seed(db, person.id, `Orden pronto ${stamp}`, plusDays(2));
  const middle = await seed(db, person.id, `Orden medio ${stamp}`, plusDays(5));

  try {
    const page = await context.newPage();
    await page.goto("/sueltas");
    const rows = page.getByRole("button", { name: new RegExp(`^Orden .* ${stamp}`) });
    await expect(rows).toHaveCount(3);
    const texts = await rows.allInnerTexts();
    expect(texts.map((text) => text.split("\n")[0])).toEqual([
      `Orden pronto ${stamp}`,
      `Orden medio ${stamp}`,
      `Orden tarde ${stamp}`,
    ]);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where id in (${late}, ${early}, ${middle})`;
  }
});

test("«Nada espera» shows only when nothing waits: not with dayless ones alone, not with scheduled ones alone (RP-59)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  const empty = /^Nada espera/;
  let dayless: string | null = null;
  let scheduled: string | null = null;

  try {
    const page = await context.newPage();
    await page.goto("/sueltas");
    await expect(page.getByText(empty)).toBeVisible();

    dayless = await seed(db, person.id, `Solo sin día ${stamp}`, null);
    await page.goto("/sueltas");
    await expect(page.getByRole("button", { name: new RegExp(`^Solo sin día ${stamp}`) })).toBeVisible();
    await expect(page.getByText(empty)).toHaveCount(0);

    await db`delete from goals.one_offs where id = ${dayless}`;
    dayless = null;
    scheduled = await seed(db, person.id, `Solo programada ${stamp}`, plusDays(9));
    await page.goto("/sueltas");
    await expect(page.getByRole("button", { name: new RegExp(`^Solo programada ${stamp}`) })).toBeVisible();
    await expect(page.getByText(empty)).toHaveCount(0);
  } finally {
    await context.close();
    if (dayless) await db`delete from goals.one_offs where id = ${dayless}`;
    if (scheduled) await db`delete from goals.one_offs where id = ${scheduled}`;
  }
});

test("a scheduled day names its month only when it falls outside this week: «martes 30», «martes 30 de octubre» (RP-59)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  const far = plusDays(14);
  const farDate = civilDateToDate(far);
  const farWords = `${words(far)} de ${MONTHS[farDate.getUTCMonth()]}`;
  const ids: string[] = [];
  ids.push(await seed(db, person.id, `Lejana ${stamp}`, far));
  // Monday to Sunday is one week: tomorrow is in it unless today is Sunday.
  const sunday = civilDateToDate(todayInZone()).getUTCDay() === 0;
  ids.push(await seed(db, person.id, `Cercana ${stamp}`, plusDays(1)));

  try {
    const page = await context.newPage();
    await page.goto("/sueltas");

    const farRow = page.getByRole("button", { name: new RegExp(`^Lejana ${stamp}`) });
    await expect(farRow).toBeVisible();
    expect(await farRow.innerText()).toContain(farWords);

    const tomorrow = plusDays(1);
    const nearRow = page.getByRole("button", { name: new RegExp(`^Cercana ${stamp}`) });
    await expect(nearRow).toBeVisible();
    const near = await nearRow.innerText();
    expect(near).toContain(words(tomorrow));
    const month = MONTHS[civilDateToDate(tomorrow).getUTCMonth()];
    expect(near.includes(`${words(tomorrow)} de ${month}`)).toBe(sunday);
    expect(MONTHS.filter((name) => near.includes(name))).toEqual(sunday ? [month] : []);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where id in ${db(ids)}`;
  }
});
