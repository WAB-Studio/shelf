
import type { Locator } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, todayHeading } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Hoy at 1024 and beyond (`HoyEscritorio.dc.html`, RNP-17): the goals left, the
// week's figure, the sueltas, «N esperan» and «hechas hoy» right; at 360 the
// order is the phone's own. «N esperan» counts dayless plus scheduled (RP-59).

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// A person of this spec's own: the counts span the identity, so only a fresh
// one can promise them. Registered under the suite's run, whose teardown drops it.
async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("no box");
  return rect;
}

async function seedGoals(db: postgres.Sql, personId: string, stamp: number) {
  const [measured] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${personId}, ${`Meta con cifra ${stamp}`}, ${plusDays(90)}, ${`minutos hablados ${stamp}`}, 'min')
    returning id
  `;
  const [plain] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${`Meta sin cifra ${stamp}`}, ${plusDays(90)}) returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    values (${personId}, ${measured.id}, ${`Hablar ${stamp}`}, 'daily', 'quantity', 5, 'min')
    returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${personId}, ${plain.id}, ${`Tocar ${stamp}`}, 'daily', 'tap')
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${personId}, ${commitment.id}, ${measured.id}, ${todayInZone()}, 12)
  `;
  return { measuredId: measured.id, plainId: plain.id };
}

test("at 1280 the goals sit left and the figure, sueltas, «N esperan» and «hechas hoy» right, with no overlap, one theme toggle and the figure of the review's current week (RNP-17, RP-27)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  const { measuredId } = await seedGoals(db, person.id, stamp);
  const doneName = `Hecha ${stamp}`;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day) values (${person.id}, ${doneName}, ${todayInZone()}) returning id
  `;
  await db`
    insert into goals.facts (user_id, one_off_id, day) values (${person.id}, ${done.id}, ${todayInZone()})
  `;
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${`Sin día ${stamp}`}, null)`;
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${`Para luego ${stamp}`}, ${plusDays(3)})`;

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/metas/${measuredId}/revision`);
    // A row still in React's hidden streaming div reads as textContent: «2026» glued to «12».
    // The review draws its weeks as bars (DESIGN «Decisión del 2026-10-31»): the current one is the row marked current.
    const currentRow = page.locator("li[data-current]");
    await expect(currentRow).toBeVisible();
    // The week's dates carry «en curso»; its total ends the row.
    await expect(currentRow).toContainText("en curso");
    const revisionNumber = (await currentRow.locator('[class*="total"]').innerText()).match(/^(\d+)\s*min$/)?.[1];
    expect(revisionNumber).toBe("12");

    await page.goto("/");
    // `load` fires with the loading fallback still standing; measure the settled page.
    await expect(page.getByText(`Hechas hoy`, { exact: true })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

    // The goal's name heads its group, and the week's figure stands at the head's end.
    const head = page.locator("[data-part='group-head']").filter({ hasText: "esta semana" });
    await expect(head).toHaveCount(1);
    // A time-unit figure is headed by the goal's name, never the unit word (RP-35).
    await expect(head.getByRole("heading", { level: 2 })).toHaveText(`Meta con cifra ${stamp}`);
    await expect(head.getByRole("heading").filter({ hasText: /^(min|minutos)$/i })).toHaveCount(0);
    const figure = await box(head.getByText("esta semana", { exact: true }));
    const sueltas = await box(page.getByText("Sueltas", { exact: true }));
    const waiting = await box(page.getByRole("link", { name: "2 esperan" }));
    const doneLabel = await box(page.getByText("Hechas hoy", { exact: true }));

    // The head carries the number the review's current week reads.
    await expect(head).toContainText(`${revisionNumber}`);
    await expect(head.getByRole("link", { name: "Ver por semana" })).toHaveAttribute(
      "href",
      `/metas/${measuredId}/revision`,
    );

    // The goals' groups in one column, «Sueltas» as a plain line closing it.
    expect(figure.y).toBeLessThan(sueltas.y);
    expect(waiting.y).toBeGreaterThan(figure.y);
    // «Hechas hoy» stands in the column beside them, never inside the goals' one.
    const goals = await box(head);
    expect(doneLabel.x).toBeGreaterThanOrEqual(goals.x + goals.width);
    expect(doneLabel.x).toBeGreaterThanOrEqual(sueltas.x + sueltas.width);

    // A goal with no measure draws no card of its own.
    await expect(page.getByText("esta semana", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Cambiar a modo/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Cambiar a modo/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(todayHeading(page)).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});

test("at 360 the sections come in the phone's own order and the figure is not drawn (RNP-07)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  await seedGoals(db, person.id, stamp);
  const doneName = `Hecha ${stamp}`;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day) values (${person.id}, ${doneName}, ${todayInZone()}) returning id
  `;
  await db`
    insert into goals.facts (user_id, one_off_id, day) values (${person.id}, ${done.id}, ${todayInZone()})
  `;

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.getByText(`Hechas hoy`, { exact: true })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // No navy block on Hoy (DESIGN «Hoy, 2026-11-01»): the goals' groups, «Sueltas» closing the list, then the done ones.
    const parts = [
      page.locator("[data-part='group-head']").filter({ hasText: `Meta con cifra ${stamp}` }),
      page.locator("[data-part='group-head']").filter({ hasText: `Meta sin cifra ${stamp}` }),
      page.getByText("Sueltas", { exact: true }),
      page.getByText("Hechas hoy", { exact: true }),
    ];
    const boxes = [];
    for (const part of parts) {
      const found = await part.boundingBox();
      expect(found).not.toBeNull();
      boxes.push(found!);
    }
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
    // Every part stands in the page's one column.
    for (const found of boxes) expect(found.x + found.width).toBeLessThanOrEqual(360);

    await expect(page.getByText("esta semana", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: /Cambiar a modo/ })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Ver por semana" })).toBeHidden();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});

test("«N esperan» is dayless plus scheduled at the same moment, and opens /sueltas (RP-59)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${`Sin día ${stamp}`}, null)`;

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("link", { name: "1 espera" })).toBeVisible();

    await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${`Para luego ${stamp}`}, ${plusDays(4)})`;
    await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${`Para más luego ${stamp}`}, ${plusDays(9)})`;
    const [counts] = await db<{ n: string }[]>`
      select count(*)::text as n from goals.one_offs o
      where o.user_id = ${person.id}
        and (o.day is null or o.day > ${todayInZone()})
        and not exists (select 1 from goals.facts f where f.one_off_id = o.id)
    `;
    expect(counts.n).toBe("3");

    await page.reload();
    const link = page.getByRole("link", { name: `${counts.n} esperan` });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL("**/sueltas");
  } finally {
    await context.close();
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});

test("a one-off done at a known instant reads its HH:mm in «hechas hoy» (RP-19)", async ({ person, browser, db }) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const name = `Hecha con hora ${Date.now()}`;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day) values (${person.id}, ${name}, ${todayInZone()}) returning id
  `;
  // Bogotá holds UTC-5 the whole year.
  await db`
    insert into goals.facts (user_id, one_off_id, day, written_at)
    values (${person.id}, ${done.id}, ${todayInZone()}, ${new Date(`${todayInZone()}T19:40:00-05:00`)})
  `;

  try {
    const page = await context.newPage();
    await page.goto("/");
    // The mark undoes; the name button beside it carries the name and its hour.
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("19:40");
  } finally {
    await context.close();
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});

test("at 1280 a goal in a time unit heads its card with its name and one in kilómetros keeps the unit word (RP-35)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  await seedGoals(db, person.id, stamp);
  const [km] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${person.id}, ${`Meta rodaje ${stamp}`}, ${plusDays(90)}, ${`rodaje ${stamp}`}, 'kilómetros') returning id
  `;
  const [rodaje] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    values (${person.id}, ${km.id}, ${`Rodar ${stamp}`}, 'daily', 'quantity', 5, 'kilómetros') returning id
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${person.id}, ${rodaje.id}, ${km.id}, ${todayInZone()}, 7)
  `;

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByText("esta semana", { exact: true })).toHaveCount(2);
    const heads = page.locator("[data-part='group-head']");
    const timeCard = heads.filter({ hasText: "12 min" });
    await expect(timeCard.getByRole("heading", { level: 2 })).toHaveText(`Meta con cifra ${stamp}`);
    await expect(timeCard.getByRole("heading").filter({ hasText: /^(min|minutos)$/i })).toHaveCount(0);
    const kmCard = heads.filter({ hasText: "7" }).filter({ hasText: "kilómetros" });
    await expect(kmCard.getByText("kilómetros", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});
