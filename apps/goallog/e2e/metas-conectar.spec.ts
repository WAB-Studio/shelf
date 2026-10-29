import { test, expect } from "./fixtures";
import { dateToCivilDate, civilDateToDate, todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// `MetasConectar.dc.html` (RP-38, RNP-07): «el plan» on /metas
// offers «Conectar una IA», with a goal and with none.

async function expectConnect(page: import("@playwright/test").Page, width: number) {
  const link = page.getByRole("link", { name: /Conectar una IA/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/conexiones");
  await expect(link).toContainText("Claude lee y reorganiza tus metas");
  expect((await boxOf(link)).height).toBeGreaterThanOrEqual(48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test("with no goal, «Conectar una IA» lands on /conexiones in one tap (RP-38)", async ({
  person,
  browser,
}) => {
  for (const width of [360, 1440]) {
    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 800 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/metas");
      await expect(page.getByRole("heading", { name: "Todavía no hay metas" })).toBeVisible();
      await expectConnect(page, width);
      await page.getByRole("link", { name: /Conectar una IA/ }).click();
      await expect(page).toHaveURL(/\/conexiones$/);
    } finally {
      await context.close();
    }
  }
});

test("with a goal, «Conectar una IA» follows «Exportar» (RP-38)", async ({
  person,
  browser,
  db,
}) => {
  const horizon = civilDateToDate(todayInZone());
  horizon.setUTCDate(horizon.getUTCDate() + 60);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Meta para conectar', ${dateToCivilDate(horizon)}, now() - interval '5 days')
    returning id
  `;
  try {
    for (const width of [360, 1440]) {
      const context = await browser.newContext({
        storageState: person.sessionFile,
        viewport: { width, height: 800 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/metas");
        await expect(page.getByText("Meta para conectar").first()).toBeVisible();
        await expectConnect(page, width);
        const exportY = (await boxOf(page.getByRole("link", { name: /Exportar/ }))).y;
        const connectY = (await boxOf(page.getByRole("link", { name: /Conectar una IA/ }))).y;
        expect(connectY).toBeGreaterThan(exportY);
        await page.getByRole("link", { name: /Conectar una IA/ }).click();
        await expect(page).toHaveURL(/\/conexiones$/);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});

test("with only an ended goal, «Conectar una IA» is there and lands on /conexiones (RP-38)", async ({
  person,
  browser,
  db,
}) => {
  const horizon = civilDateToDate(todayInZone());
  horizon.setUTCDate(horizon.getUTCDate() - 10);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Meta ya terminada', ${dateToCivilDate(horizon)}, now() - interval '40 days')
    returning id
  `;
  try {
    for (const width of [360, 1440]) {
      const context = await browser.newContext({
        storageState: person.sessionFile,
        viewport: { width, height: 800 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/metas");
        await expect(page.getByText("Meta ya terminada").first()).toBeVisible();
        await expectConnect(page, width);
        await page.getByRole("link", { name: /Conectar una IA/ }).click();
        await expect(page).toHaveURL(/\/conexiones$/);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
