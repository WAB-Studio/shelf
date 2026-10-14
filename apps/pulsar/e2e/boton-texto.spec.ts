import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// From 1024 a button or link-button standing alone in a `Page`
// column is as wide as its text (160 at least), at the column's start; below
// 1024 it keeps the column's width.

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
const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const horizon = nextMonth(nextMonth(thisMonth));

test("a goal's /meses with no amount: «Planear» is its text wide at 1440 and the column wide at 390", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta boton ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/meses`);
    const plan = page.getByRole("link", { name: `Planear ${NAMES[Number(thisMonth.slice(5, 7)) - 1]}` });
    await expect(plan).toBeVisible();
    const box = (await boxOf(plan));
    expect(box.width).toBeGreaterThanOrEqual(160);
    expect(box.width).toBeLessThanOrEqual(320);
    const header = (await boxOf(page.locator("main > header").first()));
    expect(Math.abs(box.x - header.x)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 900 });
    const narrow = (await boxOf(plan));
    expect(narrow.width).toBeGreaterThanOrEqual(349);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

test("/entrar's button is its text wide at 1440", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/entrar");
    const button = page.getByRole("button", { name: "Enviar enlace" });
    await expect(button).toBeVisible();
    const box = (await boxOf(button));
    expect(box.width).toBeGreaterThanOrEqual(160);
    expect(box.width).toBeLessThanOrEqual(320);
  } finally {
    await context.close();
  }
});
