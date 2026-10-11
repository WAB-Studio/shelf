import { test, expect } from "./fixtures";
import month from "../messages/es/month.json";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `Meses.dc.html`, `MesesEscritorio`, `MesPlan.dc.html` (RP-28,
// RP-32, RP-35): a goal read month by month, and the sheet that sets,
// changes and removes a month's amount.

const NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function label(month: string): string {
  return NAMES[Number(month.slice(5, 7)) - 1];
}

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
// A closed month says where its share went: the month after it.
const carried = (percent: number) =>
  month.months.carriedTo.replace("{percent}", String(percent)).replace("{month}", label(thisMonth));
const followingMonth = nextMonth(thisMonth);
const horizon = nextMonth(followingMonth);
const seg = (month: string) => month.slice(0, 7);

// Opened last month with a measure in minutes; the horizon leaves next month
// in the span, with nothing in it.
async function seedGoal(db: import("postgres").Sql, personId: string, name: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  return goal.id;
}

test("the months read planned, reached and the share carried; the sheet sets, changes and removes an amount in hours and minutes (RP-28, RP-32, RP-35)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta meses ${stamp}`);
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${lastMonth}::date, 600)
  `;
  // 100 done in the month, 200 left: 200 of 300 carried, 66.67 floors to 66.
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${`Hecha ${stamp}`}, ${lastMonth}::date, 100) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goalId}, ${done.id}, ${lastMonth}::date + 14)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${`Pendiente ${stamp}`}, ${lastMonth}::date, 200)
  `;

  const stored = async () => {
    const rows = await db<{ amount: number }[]>`
      select amount from goals.month_budgets
      where goal_id = ${goalId} and month = ${thisMonth}::date
    `;
    return rows.map((row) => row.amount);
  };

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}/meses`);
    await expect(page.locator("main")).toHaveCount(1);

    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(3);
    const last = items.nth(0);
    await expect(last).toContainText(label(lastMonth));
    await expect(last).toContainText("1 h 40 min");
    await expect(last).toContainText("de 10 h");
    await expect(last).toContainText(carried(66));
    // The whole row is the one link, named with its year; the state sits under the name, never in the note.
    await expect(last.getByRole("link")).toHaveCount(1);
    await expect(last).toContainText(`${label(lastMonth)} ${lastMonth.slice(0, 4)}`);
    // A time goal with no rhythm counts the month's tasks (RP-73): the state is the first of the detail's two lines.
    await expect(last.locator("span").filter({ hasText: new RegExp(`^${carried(66)}\\s*\\d+\\stareas?$`) })).toHaveCount(1);
    // A closed month's amount is text, never a door to the sheet.
    await expect(last.getByText("de 10 h", { exact: true })).toBeVisible();
    await expect(page.locator("main a[href*=planear]:visible")).toHaveCount(0);
    await expect(last.getByRole("link", { name: label(lastMonth) })).toHaveAttribute(
      "href",
      `/metas/${goalId}/meses/${lastMonth.slice(0, 7)}`,
    );
    const current = page.locator("li[data-current]");
    await expect(current).toContainText(label(thisMonth));
    await expect(current).toContainText("en curso");
    await expect(current).toContainText("sin monto");
    await expect(current).not.toContainText(carried(66).replace("66 %", "").replace(label(thisMonth), "").trim());
    // A month with nothing is still a row, and says so, and carries no share.
    await expect(items.nth(2)).toContainText(label(followingMonth));
    await expect(items.nth(2)).toContainText("sin monto");
    await expect(items.nth(2)).not.toContainText("%");
    await expect(items.nth(2)).not.toContainText("planeado");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // Set: the amount is set from the month's own page. 12 and 30 are 750, read back in the row.
    await current.getByRole("link").click();
    await page.waitForURL(`**/meses/${seg(thisMonth)}`);
    await page.getByRole("link", { name: "sin monto planeado" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: `¿Cuánto en ${label(thisMonth)}?` })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^quitar el monto/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await sheet.getByLabel("horas", { exact: true }).fill("12");
    await sheet.getByLabel("minutos", { exact: true }).fill("30");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(current).toContainText("de 12 h 30 min");
    await expect(current).not.toContainText("sin monto");
    expect(await stored()).toEqual([750]);

    // A future month with an amount reads «planeado» under its name, «—» for the
    // figure and the bare amount, with no «de».
    await page.goto(`/metas/${goalId}/meses?planear=${followingMonth.slice(0, 7)}`);
    await sheet.getByLabel("horas", { exact: true }).fill("12");
    await sheet.getByLabel("minutos", { exact: true }).fill("0");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toHaveCount(0);
    const future = items.nth(2);
    await expect(future).toContainText("planeado");
    await expect(future).toContainText("—");
    await expect(future).toContainText("12 h");
    await expect(future).not.toContainText("de 12 h");
    await expect(future).not.toContainText("sin monto");

    // Refused: 60 minutes is no minute count, and nothing changes.
    await page.goto(`/metas/${goalId}/meses?planear=${seg(thisMonth)}`);
    await expect(sheet.getByLabel("horas", { exact: true })).toHaveValue("12");
    await expect(sheet.getByLabel("minutos", { exact: true })).toHaveValue("30");
    await sheet.getByLabel("minutos", { exact: true }).fill("60");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet.getByText("Los minutos van de 0 a 59.")).toBeVisible();
    expect(await stored()).toEqual([750]);

    // Changed.
    await sheet.getByLabel("minutos", { exact: true }).fill("45");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(current).toContainText("de 12 h 45 min");
    expect(await stored()).toEqual([765]);

    // Removed.
    await page.goto(`/metas/${goalId}/meses?planear=${seg(thisMonth)}`);
    await sheet.getByRole("button", { name: `quitar el monto de ${label(thisMonth)}` }).click();
    await expect(sheet).toHaveCount(0);
    await expect(current).toContainText("sin monto");
    expect(await stored()).toEqual([]);

    // From 1024 the list and the current month stand side by side, one h1 over both.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("main ol a:visible")).toHaveCount(3);
    await expect(page.locator("main ol a[aria-current=page]")).toContainText(label(thisMonth));
    await expect(page.getByRole("heading", { level: 2 })).toContainText(label(thisMonth), { ignoreCase: true });
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("?planear= opens the sheet on that month and ignores a month outside the span (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta planear ${Date.now()}`);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/meses?planear=${followingMonth.slice(0, 7)}`);
    await expect(
      page.getByRole("heading", { name: `¿Cuánto en ${label(followingMonth)}?` }),
    ).toBeVisible();

    await page.goto(`/metas/${goalId}/meses?planear=2001-01`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Nothing is planned anywhere: the empty face names the way in.
    await expect(page.getByText(/^Ningún mes tiene monto/)).toBeVisible();
    // A sentence, never a figure: Archivo, not mono.
    expect(await page.getByText(/^Ningún mes tiene monto/).evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
    await page.getByRole("link", { name: `Planear ${label(thisMonth)}` }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a unit that is no time takes one field and stores the number as typed (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta páginas ${Date.now()}`);
  await db`update goals.goals set measure_unit = 'páginas', measure_name = 'páginas' where id = ${goalId}`;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/meses?planear=${thisMonth.slice(0, 7)}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByLabel("horas")).toHaveCount(0);
    await sheet.getByLabel("cuánto, en páginas").fill("40");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator("li[data-current]")).toContainText("de 40 páginas");
    const rows = await db<{ amount: number }[]>`select amount from goals.month_budgets where goal_id = ${goalId}`;
    expect(rows.map((row) => row.amount)).toEqual([40]);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a goal with no measure lists every month of its span with its task count, each leading to its page; an unknown goal 404s (RP-31, RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta sin medida ${stamp}`}, ${horizon}::date, (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  const task = async (name: string, month: string | null, parent: string | null = null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id)
      values (${person.id}, ${goal.id}, ${name}, ${month === null ? null : db`${month}::date`}, ${parent}) returning id
    `;
    return row.id;
  };
  await task(`Pasada ${stamp}`, lastMonth);
  const parent = await task(`Madre ${stamp}`, thisMonth);
  await task(`Hija ${stamp}`, null, parent);
  await task(`Otra ${stamp}`, thisMonth);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goal.id}/meses`);
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
    await expect(page.getByText("Esta meta no mide nada, así que no lleva montos ni tiempo.")).toHaveCount(0);
    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText(label(lastMonth));
    await expect(items.nth(0)).toContainText("1 tarea");
    const current = page.locator("li[data-current]");
    await expect(current).toContainText(label(thisMonth));
    await expect(current).toContainText("en curso");
    // The sub-task is no row of its own; last month's undone task rides into this one (RP-31).
    await expect(current).toContainText("3 tareas");
    await expect(items.nth(2)).toContainText(label(followingMonth));
    await expect(items.nth(2)).toContainText("sin tareas");
    // No figure, no amount, no door to the sheet.
    await expect(page.getByText(/sin monto|planeado|%/)).toHaveCount(0);
    for (const href of await page.locator("main a").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href") ?? ""),
    )) {
      expect(href).not.toContain("planear");
    }
    await expect(items.nth(0).getByRole("link", { name: label(lastMonth) })).toHaveAttribute(
      "href",
      `/metas/${goal.id}/meses/${seg(lastMonth)}`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("main ol a", { hasText: label(lastMonth) }).click();
    await page.waitForURL(`**/metas/${goal.id}/meses/${seg(lastMonth)}`);

    await page.goto("/metas/00000000-0000-0000-0000-000000000000/meses");
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a closed month's amount is text and ?planear= on it mounts no sheet; this month's still opens it (RP-28, RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta cerrado ${Date.now()}`);
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${lastMonth}::date, 600), (${person.id}, ${goalId}, ${thisMonth}::date, 300)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/meses?planear=${seg(lastMonth)}`);
    await expect(page.getByRole("listitem").first()).toContainText("de 10 h");
    await expect(page.locator("main a[href*=planear]:visible")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^quitar el monto/ })).toHaveCount(0);

    await page.goto(`/metas/${goalId}/meses?planear=${seg(thisMonth)}`);
    await expect(page.getByRole("dialog").getByRole("heading", { name: `¿Cuánto en ${label(thisMonth)}?` })).toBeVisible();
    await page.goto(`/metas/${goalId}/meses`);
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await page.getByRole("link", { name: "de 5 h" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a future month with no amount of its own reads the rhythm; one with its own reads that (RP-32, RP-50)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta ritmo ${Date.now()}`);
  await db`update goals.goals set rhythm = 300 where id = ${goalId}`;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${thisMonth}::date, 600)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}/meses`);
    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(1)).toContainText("de 10 h");
    await expect(items.nth(2)).toContainText(label(followingMonth));
    await expect(items.nth(2)).toContainText("5 h");
    await expect(items.nth(2)).not.toContainText("sin monto");
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a closed month over half carried offers no shift line, in the list or anywhere (RP-50)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta sin corrimiento ${Date.now()}`);
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${thisMonth}::date, 600), (${person.id}, ${goalId}, ${lastMonth}::date, 600)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, 'Sigue', ${lastMonth}::date, 100)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}/meses`);
    await expect(page.getByRole("listitem").first()).toContainText(carried(100));
    await expect(page.getByRole("button", { name: "correr el plan un mes" })).toHaveCount(0);
    await expect(page.getByText(/correr/i)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("an ended goal and an archived one read their months and offer no way into the sheet (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const openedOn = new Date(Date.now() - 20 * 86_400_000);
  const [ended] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta terminada ${stamp}`}, ${todayInZone()}::date, 'minutos', 'minutos', ${openedOn})
    returning id
  `;
  const archivedId = await seedGoal(db, person.id, `Meta archivada ${stamp}`);
  await db`update goals.goals set archived_at = now() where id = ${archivedId}`;
  const openedMonth = monthOf(openedOn.toISOString().slice(0, 10));
  // A budget keeps the empty face out of the way: the guard under test is the row's.
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${ended.id}, ${openedMonth}::date, 600),
           (${person.id}, ${archivedId}, ${lastMonth}::date, 600)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const [goalId, month] of [
      [ended.id, openedMonth],
      [archivedId, lastMonth],
    ]) {
      await page.goto(`/metas/${goalId}/meses`);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByRole("listitem").first()).toContainText("de 10 h");
      await expect(page.locator("main a[href*=planear]:visible")).toHaveCount(0);
      await expect(page.getByRole("link", { name: /^Planear / })).toHaveCount(0);
      await expect(page.getByText(/^Toca un mes/)).toHaveCount(0);
      await expect(
        page.getByRole("listitem").first().getByRole("link", { name: label(month) }),
      ).toHaveAttribute("href", `/metas/${goalId}/meses/${month.slice(0, 7)}`);

      await page.goto(`/metas/${goalId}/meses?planear=${month.slice(0, 7)}`);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("each month is a whole 48 px link in ink to its month; one h1; the back reaches the goal; from 1024 the current month stands beside the list and tapping another swaps it (RP-32, RP-28, RNP-16, RNP-17)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  test.slow();
  const stamp = Date.now();
  const name = `Meta filas ${stamp}`;
  const goalId = await seedGoal(db, person.id, name);
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${lastMonth}::date, 600), (${person.id}, ${goalId}, ${thisMonth}::date, 720)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const width of [360, 390, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goalId}/meses`);
      await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toHaveCount(1);
      const rows = page.locator("main ol a:visible");
      await expect(rows).toHaveCount(3);
      for (const row of await rows.all()) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
        expect(await row.evaluate((node) => getComputedStyle(node).color)).not.toBe("rgb(0, 0, 238)");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      if (width >= 1024) {
        await expect(page.locator("main ol a[aria-current=page]")).toContainText(label(thisMonth));
        const listBox = (await rows.first().boundingBox())!;
        const detailBox = (await page.getByRole("heading", { level: 2 }).boundingBox())!;
        expect(listBox.x + listBox.width).toBeLessThan(detailBox.x);
        await rows.first().click();
        await page.waitForURL(`**/meses/${seg(lastMonth)}`);
        await expect(rows).toHaveCount(3);
        await expect(page.locator("main ol a[aria-current=page]")).toContainText(label(lastMonth));
      } else {
        await rows.first().click();
        await page.waitForURL(`**/meses/${seg(lastMonth)}`);
        await page.goBack();
      }

      await page.goto(`/metas/${goalId}/meses`);
      await page.getByRole("link", { name: `Volver a ${name}` }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goalId}$`));
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

// RP-28: the amount of a month still to come is a door to the sheet only while
// the goal is open. The month in play and a coming one are the months the
// sheet could reach, so they are where an ended or archived goal must refuse.
test("an ended goal and an archived one refuse the sheet on this month and a coming one, in the list and on the month's page (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const [ended] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta terminada mes ${stamp}`}, ${todayInZone()}::date, 'minutos', 'minutos', now() - interval '20 days')
    returning id
  `;
  const archivedId = await seedGoal(db, person.id, `Meta archivada mes ${stamp}`);
  await db`update goals.goals set archived_at = now() where id = ${archivedId}`;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${ended.id}, ${thisMonth}::date, 300),
           (${person.id}, ${archivedId}, ${thisMonth}::date, 300),
           (${person.id}, ${archivedId}, ${followingMonth}::date, 300)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const [goalId, months] of [
      [ended.id, [thisMonth]],
      [archivedId, [thisMonth, followingMonth]],
    ] as const) {
      for (const month of months) {
        await page.goto(`/metas/${goalId}/meses?planear=${seg(month)}`);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.getByRole("dialog")).toHaveCount(0);

        await page.goto(`/metas/${goalId}/meses/${seg(month)}`);
        await expect(page.locator("main")).toHaveCount(1);
        // A month that has not begun says its amount alone, beside «planeado»; this one is «de 5 h» after what was reached.
        await expect(page.getByText(month === thisMonth ? "de 5 h" : "5 h", { exact: true }).locator("visible=true")).toHaveCount(1);
        await expect(page.locator("main a[href*=planear]:visible")).toHaveCount(0);
      }
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

// RP-32: only the months of the goal's span exist as pages.
test("a month before the goal was written, one past its horizon and a malformed one are not pages (RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta fuera de rango ${Date.now()}`);
  const before = monthOf(dayBefore(lastMonth));
  const after = nextMonth(horizon);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await expect(page.getByRole("heading", { name: label(thisMonth), level: 1 })).toBeVisible();
    for (const month of [seg(before), seg(after), "2026-13", "2026-00", "26-10"]) {
      await page.goto(`/metas/${goalId}/meses/${month}`);
      await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
