import type { Locator } from "@playwright/test";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import connections from "../messages/es/connections.json";
import { test, expect } from "./fixtures";

// RP-38, RP-43, RP-53: a line that mixes words and figures is Archivo, and only
// its figures and dates are DM Mono (`SistemaPiezas`). The new key's name is a
// name, never a mono-caps label (`ConexionesCreada`).

async function expectMixed(line: Locator, figures: string[]) {
  const set = await line.evaluate((el) => ({
    family: getComputedStyle(el).fontFamily,
    spans: Array.from(el.querySelectorAll("span")).map((span) => ({
      text: span.textContent,
      family: getComputedStyle(span).fontFamily,
    })),
  }));
  expect(set.family).not.toMatch(/mono/i);
  expect(set.spans.map((span) => span.text)).toEqual(figures);
  for (const span of set.spans) expect(span.family).toMatch(/mono/i);
}

const today = todayInZone();
const thisMonth = monthOf(today);
const WIDTHS: [number, number][] = [
  [390, 844],
  [1440, 900],
];

test.describe("mixed lines are Archivo with figures in mono (RP-38, RP-43, RP-53)", () => {
  test("«Mes»: «de 10 h» beside the goal's figure", async ({ person, browser, baseURL, db }) => {
    const stamp = Date.now();
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Inglés ${stamp}`}, ${`${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`}::date, 'minutos', 'minutos', now() - interval '40 days')
      returning id`;
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${thisMonth}::date, 600)`;
    for (const [width, height] of WIDTHS) {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto("/mes");
        const line = page.locator("main span").filter({ hasText: /^de 10 h$/ }).first();
        await expect(line).toBeVisible();
        await expectMixed(line, ["10 h"]);
      } finally {
        await context.close();
      }
    }
  });

  test("the plan's end: «Con 11 h al mes llegas a tiempo.»", async ({ person, browser, baseURL, db }) => {
    const year = Number(today.slice(0, 4));
    const horizon = nextMonth(nextMonth(nextMonth(thisMonth)));
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm)
      values (${person.id}, ${`Meta fin ${year}-${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', 480)
      returning id`;
    let position = 0;
    for (const [name, estimate] of [["A", 480], ["B", 480], ["C", 480], ["D", 240], ["E", 300]] as [string, number][]) {
      position += 1;
      await db`
        insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
        values (${person.id}, ${goal.id}, ${name}, ${estimate}, ${position}, true)`;
    }
    for (const [width, height] of WIDTHS) {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto(`/metas/${goal.id}/plan`);
        const line = page.getByText(/^Con .* al mes llegas a tiempo\.$/);
        await expect(line).toBeVisible();
        await expectMixed(line, [(await line.textContent())!.match(/Con (.*) al mes/)![1]]);
      } finally {
        await context.close();
      }
    }
  });

  test("a key's line: «Creada hoy a las 12:18 · sin usar», and the new key's name is a name", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    await db`
      insert into goals.access_tokens (user_id, kind, name, token_hash, hint, created_at)
      values (${person.id}, 'personal', 'mi pc', ${Buffer.from(`mi-pc-${Math.random()}`)}, 'abcd', ${`${today}T12:00:00Z`})`;
    for (const [width, height] of WIDTHS) {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto("/conexiones");
        const line = page.getByText(/^Creada hoy a las \d\d:\d\d · sin usar$/);
        await expect(line).toBeVisible();
        const time = (await line.textContent())!.match(/(\d\d:\d\d)/)![1];
        await expectMixed(line, [time]);

        await page.getByLabel(connections.nameLabel).fill("portátil del trabajo");
        await page.getByRole("button", { name: connections.create }).click();
        await expect(page.getByRole("heading", { level: 1, name: connections.created.title })).toBeVisible();
        // The key's own name is the section's label, not a «llaves» group with a name under it.
        await expect(page.getByText(connections.sections.keys, { exact: true })).toHaveCount(0);
        const name = page.getByText("portátil del trabajo", { exact: true });
        await expect(name).toBeVisible();
        const set = await name.evaluate((el) => {
          const style = getComputedStyle(el);
          return { family: style.fontFamily, transform: style.textTransform };
        });
        // The name is the section's label, and a label is Archivo in sentence case, never mono (DESIGN «Sentence case»).
        expect(set.family).toMatch(/archivo/i);
        expect(set.family).not.toMatch(/mono/i);
        expect(set.transform).toBe("none");
        const sentence = page.getByText("Prueba: «lee mis metas y dime qué sigue».", { exact: true });
        expect(await sentence.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
      } finally {
        await context.close();
      }
      await db`delete from goals.access_tokens where user_id = ${person.id} and name <> 'mi pc'`;
    }
  });

  test("a revoked key's and a claude.ai connection's lines", async ({ person, browser, baseURL, db }) => {
    const seed = (kind: string, name: string, created: string, used: string | null, revoked: string | null) => db`
      insert into goals.access_tokens (user_id, kind, name, token_hash, hint, created_at, last_used_at, revoked_at)
      values (${person.id}, ${kind}, ${name}, ${Buffer.from(`${name}-${Math.random()}`)}, ${kind === "personal" ? "abcd" : null}, ${created}, ${used}, ${revoked})`;
    await seed("personal", "Vieja", "2026-01-01T10:00:00Z", null, "2026-02-03T10:00:00Z");
    await seed("oauth", "Claude", "2026-03-01T10:00:00Z", "2026-03-02T10:00:00Z", null);
    for (const [width, height] of WIDTHS) {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto("/conexiones");
        // Dead for over 30 days, so the row sits behind its fold (RP-64).
        await page.getByRole("button", { name: /^1 llave que ya no entra$/ }).click();
        const revoked = page.getByText(/^revocada el .* · ya no entra$/);
        await expect(revoked).toBeVisible();
        await expectMixed(revoked, ["3 feb 2026"]);
        const oauth = page.getByText(/^conectada el .* · usada el .*$/);
        await expect(oauth).toBeVisible();
        await expectMixed(oauth, ["1 mar 2026", "2 mar 2026", expect.stringMatching(/^\d\d:\d\d$/) as unknown as string]);
      } finally {
        await context.close();
      }
    }
  });
});
