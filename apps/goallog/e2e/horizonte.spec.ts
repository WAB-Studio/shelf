import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { dayBefore, horizonForWeeks } from "@/lib/day/weeks";
import { addWeeksToCivilDate, civilDateInZone, civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";

// RP-11, RP-25: a goal's horizon moves in weeks from its own screen, and a new
// goal's lands on a week's edge. Every goal is seeded under this spec's own
// identity and deleted by id in `finally`.

const DAY_MS = 86_400_000;

// Module 931 (RP-108): every sheet counts «semanas, contando esta». Plain day arithmetic, never the app's own helpers.
const weeksBetweenMondays = (from: string, to: string) =>
  Math.round((civilDateToDate(to).getTime() - civilDateToDate(from).getTime()) / DAY_MS / 7);
const thisMonday = () => weekOf(todayInZone())[0];

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  opts: { openedDaysAgo?: number; weeks: number; archived?: boolean },
): Promise<{ goalId: string; openedOn: string }> {
  // The opening comes from the day the server reads (`PULSAR_CLOCK` pins it), at noon in Bogotá: never from this process's `Date.now()`.
  const openedOn = dateToCivilDate(new Date(civilDateToDate(todayInZone()).getTime() - (opts.openedDaysAgo ?? 0) * DAY_MS));
  const createdAt = new Date(`${openedOn}T17:00:00Z`);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, archived_at)
    values (${personId}, ${name}, ${horizonForWeeks(openedOn, opts.weeks)}, ${createdAt},
            ${opts.archived ? new Date() : null})
    returning id
  `;
  return { goalId: goal.id, openedOn };
}

async function horizonOf(db: postgres.Sql, goalId: string): Promise<string> {
  const [row] = await db<{ horizon: string }[]>`
    select horizon::text as horizon from goals.goals where id = ${goalId}
  `;
  return row.horizon;
}

async function openHorizonSheet(page: Page, goalId: string) {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("moving to 16 weeks counted from this one writes the Monday after them; the screen counts from the opening (RP-11, RP-25, RP-108)", async ({
  page,
  db,
  personId,
}) => {
  const { goalId, openedOn } = await seedGoal(db, personId, `Meta horizonte ${Date.now()}`, {
    // Opened on a Saturday, never a Monday: on a Monday «opening + 7·N» and a
    // week's edge are the same day and a wrong function would pass.
    openedDaysAgo: 2,
    weeks: 12,
  });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^12 semanas · hasta el /)).toBeVisible();

    const sheet = await openHorizonSheet(page, goalId);
    // The sheet counts from this week; the screen behind keeps counting from the opening.
    const stored = horizonForWeeks(openedOn, 12);
    await expect(sheet.getByLabel(/^semanas, contando esta$/)).toHaveValue(String(weeksBetweenMondays(thisMonday(), stored)));
    await sheet.getByLabel(/^semanas, contando esta$/).fill("16");
    const target = addWeeksToCivilDate(thisMonday(), 16);
    const end = dayBefore(target);
    const sunday = `${Number(end.slice(8, 10))} ${new Intl.DateTimeFormat("es-CO", { month: "long", timeZone: "UTC" })
      .format(new Date(`${end}T12:00:00Z`))
      .slice(0, 3)} ${end.slice(0, 4)}`;
    await expect(sheet.getByText(`termina el ${sunday}`)).toBeVisible();
    await sheet.getByRole("button", { name: "Moverlo" }).click();
    await expect(sheet).toBeHidden();

    await expect(page.getByText(`${weeksBetweenMondays(weekOf(openedOn)[0], target)} semanas · hasta el ${sunday}`, { exact: true })).toBeVisible();
    expect(await horizonOf(db, goalId)).toBe(target);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a count ending before a phase is refused with its message and the column stays (RP-25)", async ({
  page,
  db,
  personId,
}) => {
  const { goalId, openedOn } = await seedGoal(db, personId, `Meta fase horizonte ${Date.now()}`, {
    weeks: 12,
  });
  const phaseName = `Contexto laboral ${Date.now()}`;
  try {
    await db`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
      values (${personId}, ${goalId}, ${phaseName}, ${openedOn},
              ${dayBefore(horizonForWeeks(openedOn, 12))})
    `;
    const before = await horizonOf(db, goalId);

    const sheet = await openHorizonSheet(page, goalId);
    // The refusal is the client's own: no server action leaves the device.
    const actionCalls: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) actionCalls.push(request.url());
    });
    const field = sheet.getByLabel(/^semanas, contando esta$/);
    await field.fill("11");

    // The refusal is read before anything is pressed, and «Moverlo» is already off.
    await expect(
      sheet.getByText(`La fase «${phaseName}» llega hasta la semana 12 (12 desde la apertura). El final no puede quedar antes.`),
    ).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(sheet.getByRole("button", { name: "Moverlo" })).toBeDisabled();
    await expect(sheet).toBeVisible();
    expect(actionCalls).toEqual([]);
    expect(await horizonOf(db, goalId)).toBe(before);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("week 1 is this week: it is not past, ends this Sunday and writes next Monday (RP-25, RP-108)", async ({ page, db, personId }) => {
  // Opened three weeks ago: counted from the opening, a «1» would be long past; counted from this week it is this week.
  const { goalId } = await seedGoal(db, personId, `Meta pasada ${Date.now()}`, {
    openedDaysAgo: 21,
    weeks: 12,
  });
  try {
    const sheet = await openHorizonSheet(page, goalId);
    await sheet.getByLabel(/^semanas, contando esta$/).fill("1");
    const sunday = weekOf(todayInZone())[6];
    await expect(sheet.getByText(`termina el ${Number(sunday.slice(8, 10))} `, { exact: false })).toBeVisible();
    await expect(sheet.getByText(/ya pasó/)).toHaveCount(0);
    await sheet.getByRole("button", { name: "Moverlo" }).click();
    await expect(sheet).toBeHidden();
    expect(await horizonOf(db, goalId)).toBe(addWeeksToCivilDate(thisMonday(), 1));
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a new goal opened with 12 reads «12 semanas» and «semana 1 de 12» on Semana (RP-11)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Nueva ${Date.now()}`;
  let goalId: string | null = null;
  // The browser's clock reads the Sunday of this week: opening + 7·12 and the
  // week's edge only differ on a day that is not a Monday.
  const [monday] = weekOf(todayInZone());
  const nextMonday = addWeeksToCivilDate(monday, 1);
  await page.clock.setFixedTime(new Date(`${dayBefore(nextMonday)}T17:00:00Z`));
  try {
    await page.goto("/metas/nueva");
    await page.getByLabel("nombre").fill(name);
    await expect(page.getByLabel("final")).toHaveValue("12");
    await page.getByRole("button", { name: "Abrirla" }).click();
    await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
    goalId = page.url().split("/metas/")[1];

    expect(await horizonOf(db, goalId)).toBe(horizonForWeeks(monday, 12));
    // The row's own `created_at` is written by the database's clock, which `PULSAR_CLOCK` does not pin: the screen counts from that day.
    const [{ created_at }] = await db<{ created_at: Date }[]>`select created_at from goals.goals where id = ${goalId}`;
    const openedMonday = weekOf(civilDateInZone(created_at))[0];
    const total = weeksBetweenMondays(openedMonday, horizonForWeeks(monday, 12));
    const current = weeksBetweenMondays(openedMonday, monday) + 1;
    await expect(page.getByText(new RegExp(`^${total} semanas · hasta el `))).toBeVisible();

    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${personId}, ${goalId}, 'Compromiso horizonte', 'daily', 'tap')
    `;
    await page.goto("/semana");
    // Both faces are in the DOM; only the phone's label is drawn at 360.
    await expect(page.getByText(`${name} · semana ${current} de ${total}`).locator("visible=true")).toHaveCount(1);
  } finally {
    if (goalId) await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("an archived goal draws no way to move its horizon (RP-24)", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId, `Meta archivada horizonte ${Date.now()}`, {
    weeks: 12,
    archived: true,
  });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^12 semanas · hasta el /)).toBeVisible();
    await expect(page.getByRole("button", { name: "mover el final" })).toHaveCount(0);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("the horizon line and its sheet hold at 360 (RNP-07)", async ({ page, db, personId }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { goalId } = await seedGoal(db, personId, `Meta 360 horizonte ${Date.now()}`, {
    weeks: 12,
  });
  try {
    await visit(page, `/metas/${goalId}`);
    const link = page.getByRole("button", { name: "mover el final" });
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await link.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect.poll(() => sheet.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    for (const control of [sheet.getByRole("button", { name: "Moverlo" }), sheet.getByRole("button", { name: "Dejarlo como está" })]) {
      const b = await control.boundingBox();
      expect(b?.height).toBeGreaterThanOrEqual(48);
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(360);
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a goal of one week reads «1 semana», never «1 semanas» (RP-11)", async ({ page, db, personId }) => {
  const { goalId } = await seedGoal(db, personId, `Meta una semana ${Date.now()}`, { weeks: 1 });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^1 semana · hasta el /)).toBeVisible();
    await expect(page.getByText(/^1 semanas/)).toHaveCount(0);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
