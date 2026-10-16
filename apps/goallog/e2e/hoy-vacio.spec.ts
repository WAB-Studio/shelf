import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// A person with no open goal reads the empty day: what to do and a link to
// open one or import a plan, never the all-ended card. An archived goal leaves the day even
// when its horizon has passed (RP-01, RP-24).

const EMPTY = "Todavía no hay nada que anotar.";

test("a person with no rows reads the empty day (RP-01)", async ({ person, browser }) => {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 360, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");

    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText(EMPTY)).toBeVisible();
    const open = page.getByRole("link", { name: "Abrir una meta" });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute("href", "/metas/nueva");
    const bring = page.getByRole("link", { name: "Importar un plan" });
    await expect(bring).toHaveAttribute("href", "/metas/importar");
    await expect(page.getByText(/hechos \d+ de \d+/)).toHaveCount(0);
    await expect(page.getByText(" terminó ")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await bring.click();
    await expect(page).toHaveURL(/\/metas\/importar$/);
  } finally {
    await context.close();
  }
});

test("an archived goal past its horizon leaves the day empty (RP-24)", async ({
  person,
  browser,
  db,
}) => {
  const past = civilDateToDate(todayInZone());
  past.setUTCDate(past.getUTCDate() - 10);
  const name = "Archivada vencida";
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, archived_at)
    values (${person.id}, ${name}, ${dateToCivilDate(past)}, now() - interval '30 days', now() - interval '1 day')
    returning id
  `;
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.goto("/");

    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText(EMPTY)).toBeVisible();
    await expect(page.getByRole("link", { name: "Abrir una meta" })).toHaveAttribute(
      "href",
      "/metas/nueva",
    );
    await expect(page.getByText(name)).toHaveCount(0);
    await expect(page.getByText(" terminó ")).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});

test("a person with no goal ever reads /metas, not a redirect (RP-37, RP-11)", async ({
  person,
  browser,
}) => {
  for (const width of [360, 1280]) {
    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 800 },
    });
    try {
      const page = await context.newPage();
      const response = await page.goto("/metas");

      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(/\/metas$/);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Todavía no hay metas" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Abrir una meta" })).toHaveAttribute("href", "/metas/nueva");
      await expect(page.getByRole("link", { name: "Importar un plan" })).toHaveAttribute("href", "/metas/importar");
      await expect(page.getByText("Exportar")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
    }
  }
});

test("Hoy and the week with no goal hold at 1280, the week unchanged (RP-37)", async ({
  person,
  browser,
}) => {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByText(EMPTY)).toBeVisible();
    await expect(page.getByRole("link", { name: "Importar un plan" })).toHaveAttribute("href", "/metas/importar");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

    await page.goto("/semana");
    await expect(page.getByText("Todavía no tienes una meta abierta.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Crear una meta" })).toHaveAttribute("href", "/metas/nueva");
    await expect(page.getByRole("link", { name: "Importar un plan" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
