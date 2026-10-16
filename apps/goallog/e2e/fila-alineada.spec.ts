import type { Locator, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// A split row (`onLeadingClick`) draws its mark and name where a plain row
// does (RNP-07, RP-02): one-offs against commitments on Hoy, a
// not-done task against a done one in a month list, at 360px.

const today = todayInZone();
const thisMonth = monthOf(today);
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

// The nearest ancestor of the name that holds a mark: the whole button of a
// plain row, the row's div of a split one.
function rowOf(page: Page, name: string): Locator {
  return page
    .getByText(name, { exact: true })
    .first()
    .locator("xpath=ancestor::*[self::button or self::div][.//*[@data-state]][1]");
}

async function lefts(page: Page, name: string): Promise<{ mark: number; name: number }> {
  const row = rowOf(page, name);
  const mark = await row.locator("[data-state]").first().boundingBox();
  const text = await page.getByText(name, { exact: true }).first().boundingBox();
  return { mark: mark!.x, name: text!.x };
}

test("on Hoy a one-off's mark and name sit where a commitment's do, and its mark button holds 48 × 56 (RNP-07)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const commitment = `Compromiso alineado ${stamp}`;
  const oneOff = `Suelta alineada ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta alineada ${stamp}`}, ${horizon}::date, now() - interval '3 days') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${person.id}, ${goal.id}, ${commitment}, 'daily', 'tap')
  `;
  await db`
    insert into goals.one_offs (user_id, name, day) values (${person.id}, ${oneOff}, ${today}::date)
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByText(oneOff, { exact: true })).toBeVisible();
    await expect(page.getByText(commitment, { exact: true })).toBeVisible();

    const button = await page.getByRole("button", { name: "Marcar como hecho" }).first().boundingBox();
    expect(button!.width).toBeGreaterThanOrEqual(48);
    expect(button!.height).toBeGreaterThanOrEqual(56);

    const plain = await lefts(page, commitment);
    const split = await lefts(page, oneOff);
    expect(Math.abs(split.mark - plain.mark)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(split.name - plain.name)).toBeLessThanOrEqual(0.5);

    // Two acts: the name opens its sheet, the mark completes.
    await page.getByRole("button", { name: oneOff, exact: true }).click();
    await expect(page.getByRole("dialog")).not.toContainText("¿Borrarla?");
    await expect(page.getByRole("dialog").getByLabel("Nombre")).toHaveValue(oneOff);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await rowOf(page, oneOff).getByRole("button", { name: "Marcar como hecho" }).click();
    await expect(page.getByRole("button", { name: `Deshacer: ${oneOff}` })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.one_offs where user_id = ${person.id} and name = ${oneOff}`;
  }
});

test("in a month list a not-done task's mark and name sit where a done one's do (RNP-07)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const open = `Tarea abierta ${stamp}`;
  const done = `Tarea hecha ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta mes alineada ${stamp}`}, ${horizon}::date, now() - interval '3 days') returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goal.id}, ${open}, ${thisMonth}::date)
  `;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goal.id}, ${done}, ${thisMonth}::date) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${task.id}, ${today}::date)
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/meses/${thisMonth.slice(0, 7)}`);
    await expect(page.getByText(open, { exact: true })).toBeVisible();
    await expect(page.getByText(done, { exact: true })).toBeVisible();

    const plain = await lefts(page, done);
    const split = await lefts(page, open);
    expect(Math.abs(split.mark - plain.mark)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(split.name - plain.name)).toBeLessThanOrEqual(0.5);
  } finally {
    await context.close();
  }
});
