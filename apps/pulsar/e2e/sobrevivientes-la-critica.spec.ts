import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { addWeeksToCivilDate, civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";

// Every row is seeded under this identity and deleted by id in `finally`.
// Paths by day: none; the goals open 6 and 3 days before today, in any week.

function shiftDay(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// A goal's horizon is the Monday after its week N: the Monday of the opening
// week plus N weeks. Derived here from `weekOf`, never from the app's own
// `horizonForWeeks`.
function horizonAfterWeeks(openedOn: string, weeks: number): string {
  return addWeeksToCivilDate(weekOf(openedOn)[0], weeks);
}

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  opts: { openedOn?: string; weeks?: number } = {},
): Promise<{ goalId: string; openedOn: string }> {
  const openedOn = opts.openedOn ?? todayInZone();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizonAfterWeeks(openedOn, opts.weeks ?? 12)},
            ${new Date(`${openedOn}T17:00:00Z`)})
    returning id
  `;
  return { goalId: goal.id, openedOn };
}

async function dropGoal(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

async function horizonOf(db: postgres.Sql, goalId: string): Promise<string> {
  const [row] = await db<{ horizon: string }[]>`
    select horizon::text as horizon from goals.goals where id = ${goalId}
  `;
  return row.horizon;
}

// «4 jul 2027»: the sheet's end date, the year always there.
function shortWithYear(day: string): string {
  return spanishDay(day, false).split(" de ").map((p, i) => (i === 1 ? p.slice(0, 3) : p)).join(" ") + ` ${day.slice(0, 4)}`;
}
function spanishDay(day: string, weekday: boolean): string {
  return new Intl.DateTimeFormat("es-CO", {
    weekday: weekday ? "long" : undefined,
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(civilDateToDate(day));
}

// «30 sep», or «30 sep 2027» when the year is not this one: the form /metas reads.
function shortEnd(day: string): string {
  const month = new Intl.DateTimeFormat("es-CO", { month: "long", timeZone: "UTC" })
    .format(civilDateToDate(day))
    .slice(0, 3);
  const label = `${Number(day.slice(8, 10))} ${month}`;
  return day.slice(0, 4) === todayInZone().slice(0, 4) ? label : `${label} ${day.slice(0, 4)}`;
}

// «miércoles 23»: the weekday from ICU, never the catalogue the screen reads.
function shortDay(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

async function openHorizonSheet(page: Page, goalId: string) {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("a past day before every goal names the goal that opened first after it, not the last (RNP-07)", async ({
  person,
  browser,
  db,
}) => {
  const day = shiftDay(todayInZone(), -7);
  const first = shiftDay(day, 1);
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile });
  const early = await seedGoal(db, person.id, `Alfa temprana ${stamp}`, { openedOn: first });
  const late = await seedGoal(db, person.id, `Omega tardía ${stamp}`, { openedOn: shiftDay(day, 4) });
  try {
    const page = await context.newPage();
    await page.goto(`/dia/${day}`);
    await expect(page.getByText("Ese día no pedía nada")).toBeVisible();
    await expect(
      page.getByText(`alfa temprana ${stamp} empezó el ${shortDay(first)}`),
    ).toBeVisible();
    await expect(page.getByText(/omega tardía/)).toHaveCount(0);
  } finally {
    await context.close();
    await dropGoal(db, person.id, early.goalId);
    await dropGoal(db, person.id, late.goalId);
  }
});

test("undoing a done one-off whose fact is already gone says so and keeps the row (RP-05)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta sin hecho ${Date.now()}`;
  const [oneOff] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day)
    values (${personId}, ${name}, ${todayInZone()}) returning id
  `;
  try {
    await page.goto("/");
    // This person's list is shared with other specs: mark this row, never whichever is last.
    await page
      .locator("button", { hasText: name })
      .locator("xpath=ancestor::div[1]")
      .getByRole("button", { name: "Marcar como hecho" })
      .click();
    const undo = page.getByRole("button", { name: `Deshacer: ${name}` });
    await expect(undo).toBeVisible();

    await db`delete from goals.facts where one_off_id = ${oneOff.id}`;
    await undo.click();

    await expect(page.getByText("Eso ya no existe. Recarga la página.")).toBeVisible();
    await expect(undo).toBeVisible();
  } finally {
    await db`delete from goals.one_offs where id = ${oneOff.id}`;
  }
});

test("a horizon typed short of the latest phase names that phase, not an earlier one (RP-25)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const { goalId, openedOn } = await seedGoal(db, personId, `Meta dos fases ${stamp}`, { weeks: 12 });
  const sundayOfWeek = (week: number) => shiftDay(horizonAfterWeeks(openedOn, week), -1);
  const later = `Fase tardía ${stamp}`;
  try {
    await db`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values
        (${personId}, ${goalId}, ${`Fase temprana ${stamp}`}, ${openedOn}, ${sundayOfWeek(3)}),
        (${personId}, ${goalId}, ${later}, ${horizonAfterWeeks(openedOn, 3)}, ${sundayOfWeek(8)})
    `;
    const before = await horizonOf(db, goalId);
    const sheet = await openHorizonSheet(page, goalId);
    await sheet.getByLabel(/^semanas, contando esta$/).fill("5");
    await sheet.getByRole("button", { name: "Moverlo" }).click();

    await expect(
      sheet.getByText(`La fase «${later}» llega hasta la semana 8. El final no puede quedar antes.`),
    ).toBeVisible();
    expect(await horizonOf(db, goalId)).toBe(before);
  } finally {
    await dropGoal(db, personId, goalId);
  }
});

test("520 weeks reads as a horizon and 521 is refused with the column unchanged (RP-11)", async ({
  page,
  db,
  personId,
}) => {
  const { goalId, openedOn } = await seedGoal(db, personId, `Meta tope ${Date.now()}`, { weeks: 12 });
  try {
    const before = await horizonOf(db, goalId);
    const sheet = await openHorizonSheet(page, goalId);
    const field = sheet.getByLabel(/^semanas, contando esta$/);

    await field.fill("520");
    await expect(
      sheet.getByText(`termina el ${shortWithYear(shiftDay(horizonAfterWeeks(openedOn, 520), -1))}`),
    ).toBeVisible();

    await field.fill("521");
    await sheet.getByRole("button", { name: "Moverlo" }).click();
    await expect(
      sheet.getByText("Escribe un número entero de semanas, entre 1 y 520."),
    ).toBeVisible();
    expect(await horizonOf(db, goalId)).toBe(before);
  } finally {
    await dropGoal(db, personId, goalId);
  }
});

test("a goal typed as 8 weeks lands on the Monday after its week 8 (RP-11)", async ({ page, db, personId }) => {
  const name = `Meta ocho semanas ${Date.now()}`;
  try {
    await page.goto("/metas/nueva");
    await page.getByLabel("nombre").fill(name);
    await page.getByLabel("horizonte").fill("8");
    await page.getByRole("button", { name: "Abrirla" }).click();
    await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);

    const [row] = await db<{ horizon: string }[]>`
      select horizon::text as horizon from goals.goals where user_id = ${personId} and name = ${name}
    `;
    expect(row.horizon).toBe(horizonAfterWeeks(todayInZone(), 8));
    await expect(page.getByText(/^8 semanas · hasta el /)).toBeVisible();
  } finally {
    await db`delete from goals.goals where user_id = ${personId} and name = ${name}`;
  }
});

test("the goal screen reads the year of an end date in another year", async ({ page, db, personId }) => {
  const { goalId, openedOn } = await seedGoal(db, personId, `Meta otro año ${Date.now()}`, { weeks: 70 });
  try {
    const sunday = shiftDay(horizonAfterWeeks(openedOn, 70), -1);
    expect(sunday.slice(0, 4)).not.toBe(todayInZone().slice(0, 4));
    for (const viewport of [{ width: 360, height: 800 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/metas/${goalId}`);
      await expect(page.getByText(`70 semanas · hasta el ${shortEnd(sunday)}`, { exact: true })).toBeVisible();
      expect(shortEnd(sunday)).toMatch(/ \d{4}$/);
    }
  } finally {
    await dropGoal(db, personId, goalId);
  }
});

test("the goal screen reads its last day, the Sunday before the horizon (RP-11)", async ({ page, db, personId }) => {
  const { goalId, openedOn } = await seedGoal(db, personId, `Meta último día ${Date.now()}`, { weeks: 12 });
  try {
    await page.goto(`/metas/${goalId}`);
    const sunday = shiftDay(horizonAfterWeeks(openedOn, 12), -1);
    const dated = /\d{4}$/.test(shortEnd(sunday)) ? shortEnd(sunday) : `${shortEnd(sunday)} ${sunday.slice(0, 4)}`;
    await expect(page.getByText(`12 semanas · hasta el ${dated}`, { exact: true })).toBeVisible();
  } finally {
    await dropGoal(db, personId, goalId);
  }
});

test("dating a dayless one-off offers no «sin día» and no date before today (RP-59, RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta por fechar ${Date.now()}`;
  const [oneOff] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day) values (${personId}, ${name}, null) returning id
  `;
  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Darle un día" }).click();
    await expect(page.getByRole("radio", { name: "hoy" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "sin día" })).toHaveCount(0);

    await page.getByRole("radio", { name: "otro día" }).click();
    await expect(page.getByLabel("qué día")).toHaveAttribute("min", todayInZone());
  } finally {
    await db`delete from goals.one_offs where id = ${oneOff.id}`;
  }
});
