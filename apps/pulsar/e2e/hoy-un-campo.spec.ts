import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { todayInZone } from "@/lib/zone";

import { boxOf } from "./box";
import { test, expect, settled, type Person } from "./fixtures";

// `HoyUnCampo` (RP-19, RP-20, RNP-02, RNP-07), decided by the user 2026-10-14: below
// 1024 Hoy has one task field, the one under «SUELTAS», and the goal is chosen inside
// it. Its words are the board's, typed here as written, never read from the catalogue.

type Db = postgres.Sql;

const GOALS = ["Leer", "Escribir", "Correr", "Inglés", "Ahorrar", "Cocinar", "Meditar"];
const FIELD = "Escribe una tarea…";

// Each goal asks something daily, or Hoy draws no group for it (RP-47). Created one
// after another, so the tree's order is the order of `GOALS`.
async function seedGoals(db: Db, personId: string, names: string[] = GOALS): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, name] of names.entries()) {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${personId}, ${name}, '2099-12-31', now() - ${`${names.length - index} days`}::interval)
      returning id
    `;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${personId}, ${goal.id}, ${`Revisar ${name.toLowerCase()}`}, 'daily', 'tap')
    `;
    ids.push(goal.id);
  }
  return ids;
}

async function open(browser: Browser, person: Person, width: number) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width, height: width < 1024 ? 740 : 900 },
    hasTouch: width < 1024,
  });
  const page = await context.newPage();
  await page.goto("/");
  await settled(page);
  if (width < 1024) await expect(page.getByPlaceholder(FIELD)).toBeVisible();
  return { context, page };
}

const rowsOf = (db: Db, personId: string, name: string) =>
  db<{ goal_id: string | null; day: string | null; in_plan: boolean }[]>`
    select goal_id, day::text as day, in_plan from goals.one_offs where user_id = ${personId} and name = ${name}
  `;

const metaGroup = (page: Page) => page.getByRole("radiogroup", { name: /^de qué meta$/i });
const cuandoGroup = (page: Page) => page.getByRole("radiogroup", { name: /^para cuándo$/i });

test.describe("at 360", () => {
  test("Hoy has one task field, under «SUELTAS», and no goal draws its own", async ({ person, browser, db }) => {
    await seedGoals(db, person.id);
    const { context, page } = await open(browser, person, 360);
    try {
      const field = page.getByRole("textbox");
      await expect(field).toHaveCount(1);
      await expect(field).toHaveAttribute("placeholder", FIELD);
      // The groups' fields may stay in the markup for 1280; none is on screen.
      await expect(page.getByLabel(/^Una tarea de /).locator("visible=true")).toHaveCount(0);
      await expect(page.getByPlaceholder(/^Una tarea de /).locator("visible=true")).toHaveCount(0);
      // The one field sits under the last goal's group, in «SUELTAS».
      const last = await boxOf(page.getByText("Revisar meditar", { exact: true }));
      expect((await boxOf(field)).y).toBeGreaterThan(last.y);
      await expect(page.getByText("Sueltas", { exact: true })).toBeVisible();
      // Empty: no choices yet.
      await expect(metaGroup(page)).toHaveCount(0);
      await expect(cuandoGroup(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a name brings «para cuándo» and «de qué meta», each with its own label, «Suelta» and «hoy» chosen, one chip per open goal in order", async ({
    person,
    browser,
    db,
  }) => {
    await seedGoals(db, person.id);
    const { context, page } = await open(browser, person, 360);
    try {
      await page.getByPlaceholder(FIELD).fill("Llamar al banco");
      await expect(page.getByText(/^para cuándo$/i)).toBeVisible();
      await expect(page.getByText(/^de qué meta$/i)).toBeVisible();
      await expect(cuandoGroup(page)).toBeVisible();
      await expect(metaGroup(page)).toBeVisible();
      const chips = metaGroup(page).getByRole("radio");
      await expect(chips).toHaveText(["Suelta", ...GOALS]);
      await expect(metaGroup(page).getByRole("radio", { name: "Suelta" })).toBeChecked();
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).not.toBeChecked();
      await expect(cuandoGroup(page).getByRole("radio", { name: "hoy" })).toBeChecked();
      // «de qué meta» stands above «para cuándo», under the field.
      const field = await boxOf(page.getByPlaceholder(FIELD));
      const meta = await boxOf(page.getByText(/^de qué meta$/i));
      const cuando = await boxOf(page.getByText(/^para cuándo$/i));
      expect(meta.y).toBeGreaterThan(field.y);
      expect(cuando.y).toBeGreaterThan(meta.y);
    } finally {
      await context.close();
    }
  });

  test("Enter with «Suelta» and «hoy» writes a loose task of today, in one go (RNP-02)", async ({ person, browser, db }) => {
    await seedGoals(db, person.id);
    const name = `Comprar pan ${Date.now()}`;
    const started = Date.now();
    const { context, page } = await open(browser, person, 360);
    try {
      const field = page.getByPlaceholder(FIELD);
      await field.fill(name);
      await field.press("Enter");
      await expect(page.getByText(name)).toBeVisible();
      expect(Date.now() - started).toBeLessThan(5000);
      const rows = await rowsOf(db, person.id, name);
      expect(rows).toEqual([{ goal_id: null, day: todayInZone(), in_plan: false }]);
      await expect(field).toHaveValue("");
    } finally {
      await context.close();
    }
  });

  test("a chosen goal takes the task: it is written for that goal, drawn in its group, announced, and the choice goes back to «Suelta»", async ({
    person,
    browser,
    db,
  }) => {
    const ids = await seedGoals(db, person.id);
    const name = `Capítulo dos ${Date.now()}`;
    const { context, page } = await open(browser, person, 360);
    try {
      const field = page.getByPlaceholder(FIELD);
      await field.fill(name);
      await metaGroup(page).getByRole("radio", { name: "Leer" }).click();
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).toBeChecked();
      await expect(metaGroup(page).getByRole("radio", { name: "Suelta" })).not.toBeChecked();
      await field.press("Enter");

      await expect(page.getByRole("status")).toHaveText("Anotada en Leer.");
      await expect(field).toHaveValue("");
      const rows = await rowsOf(db, person.id, name);
      expect(rows).toEqual([{ goal_id: ids[0], day: todayInZone(), in_plan: false }]);

      // Drawn in Leer's group: between Leer's label and Escribir's.
      const task = await boxOf(page.getByText(name, { exact: true }));
      const groupLabel = (goal: string) => page.locator("main").locator('[data-part="section-label"]', { hasText: new RegExp(`^${goal}$`) }).locator("visible=true").first();
      const leer = await boxOf(groupLabel("Leer"));
      const escribir = await boxOf(groupLabel("Escribir"));
      expect(task.y).toBeGreaterThan(leer.y);
      expect(task.y).toBeLessThan(escribir.y);

      // The next name starts from «Suelta» again.
      await field.fill("Otra cosa");
      await expect(metaGroup(page).getByRole("radio", { name: "Suelta" })).toBeChecked();
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).not.toBeChecked();
    } finally {
      await context.close();
    }
  });

  test("«sin día» with a goal says it stayed in its plan and links to it", async ({ person, browser, db }) => {
    const ids = await seedGoals(db, person.id);
    const name = `Sin día ${Date.now()}`;
    const { context, page } = await open(browser, person, 360);
    try {
      await page.getByPlaceholder(FIELD).fill(name);
      await metaGroup(page).getByRole("radio", { name: "Leer" }).click();
      await cuandoGroup(page).getByRole("radio", { name: "sin día" }).click();
      await page.getByRole("button", { name: "Anotar" }).click();

      const status = page.getByRole("status");
      await expect(status).toContainText("Quedó en el plan de Leer.");
      await expect(status.getByRole("link", { name: /^ver el plan$/i })).toHaveAttribute("href", `/metas/${ids[0]}/plan`);
      const rows = await rowsOf(db, person.id, name);
      expect(rows).toEqual([{ goal_id: ids[0], day: null, in_plan: true }]);
      await expect(page.getByPlaceholder(FIELD)).toHaveValue("");
      await expect(metaGroup(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("pending: the field and the choices are disabled, a second submit writes no second row", async ({ person, browser, db }) => {
    await seedGoals(db, person.id);
    const name = `Pendiente ${Date.now()}`;
    const { context, page } = await open(browser, person, 360);
    try {
      let calls = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() !== "POST" || !request.headers()["next-action"]) {
          await route.continue();
          return;
        }
        calls += 1;
        if (calls === 1) await held;
        await route.continue();
      });

      const field = page.getByPlaceholder(FIELD);
      await field.fill(name);
      await metaGroup(page).getByRole("radio", { name: "Leer" }).click();
      await cuandoGroup(page).getByRole("radio", { name: "sin día" }).click();
      await page.getByRole("button", { name: "Anotar" }).click();

      await expect(field).toBeDisabled();
      await expect(metaGroup(page).getByRole("radio", { name: "Suelta" })).toBeDisabled();
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).toBeDisabled();
      await expect.poll(() => calls).toBe(1);
      // A second submit that no control can send: the form itself.
      await page.locator("form").filter({ has: field }).evaluate((form: HTMLFormElement) => form.requestSubmit());
      release();

      await expect(page.getByRole("status")).toBeVisible();
      expect(await rowsOf(db, person.id, name)).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      await context.close();
    }
  });

  test("rejected: an empty name says so and writes nothing; a name too long is refused and the text stays", async ({
    person,
    browser,
    db,
  }) => {
    await seedGoals(db, person.id);
    const { context, page } = await open(browser, person, 360);
    try {
      const field = page.getByPlaceholder(FIELD);
      await field.fill("   ");
      await field.press("Enter");
      await expect(page.getByText("Escribe el nombre de la tarea.")).toBeVisible();
      await expect(page.getByText("Escribe qué es lo suelto.")).toHaveCount(0);
      await expect(page.getByText("Escribe qué hay que hacer.")).toHaveCount(0);

      const long = `L${"a".repeat(130)}`;
      await field.fill(long);
      await metaGroup(page).getByRole("radio", { name: "Correr" }).click();
      await field.press("Enter");
      await expect(page.getByText("Es muy largo. Escribe máximo 120 caracteres.")).toBeVisible();
      await expect(field).toHaveValue(long);
      await expect(metaGroup(page).getByRole("radio", { name: "Correr" })).toBeChecked();
      const rows = await db`select 1 from goals.one_offs where user_id = ${person.id}`;
      expect(rows).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("a write the server never answers leaves the text and the choice where they were", async ({ person, browser, db }) => {
    await seedGoals(db, person.id);
    const name = `Se cae ${Date.now()}`;
    const { context, page } = await open(browser, person, 360);
    try {
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"]) await route.abort();
        else await route.continue();
      });
      const field = page.getByPlaceholder(FIELD);
      await field.fill(name);
      await metaGroup(page).getByRole("radio", { name: "Leer" }).click();
      await field.press("Enter");
      await expect(field).toBeEnabled();
      await expect(field).toHaveValue(name);
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).toBeChecked();
      expect(await rowsOf(db, person.id, name)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("deleting the name takes the choices away; the next name starts from «Suelta»", async ({ person, browser, db }) => {
    await seedGoals(db, person.id);
    const { context, page } = await open(browser, person, 360);
    try {
      const field = page.getByPlaceholder(FIELD);
      await field.fill("Algo");
      await metaGroup(page).getByRole("radio", { name: "Leer" }).click();
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).toBeChecked();
      await field.fill("");
      await expect(metaGroup(page)).toHaveCount(0);
      await expect(cuandoGroup(page)).toHaveCount(0);
      await field.fill("Otra");
      await expect(metaGroup(page).getByRole("radio", { name: "Suelta" })).toBeChecked();
      await expect(metaGroup(page).getByRole("radio", { name: "Leer" })).not.toBeChecked();
    } finally {
      await context.close();
    }
  });

  test("with no open goal there is no «de qué meta», and «para cuándo» is still there", async ({ person, browser }) => {
    const { context, page } = await open(browser, person, 360);
    try {
      const field = page.getByPlaceholder(FIELD);
      await expect(field).toBeVisible();
      await field.fill("Renovar el pasaporte");
      await expect(page.getByText(/^para cuándo$/i)).toBeVisible();
      await expect(page.getByText(/^de qué meta$/i)).toHaveCount(0);
      await expect(metaGroup(page)).toHaveCount(0);
      await expect(page.getByRole("radio", { name: "Suelta" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("an ended goal is not offered, whatever it still asks", async ({
    person,
    browser,
    db,
  }) => {
    await seedGoals(db, person.id, ["Leer"]);
    const [ended] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, 'Vieja', '2020-01-01', now() - interval '900 days') returning id
    `;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${person.id}, ${ended.id}, 'Repasar', 'daily', 'tap')
    `;
    const { context, page } = await open(browser, person, 360);
    try {
      await page.getByPlaceholder(FIELD).fill("Algo");
      await expect(metaGroup(page).getByRole("radio")).toHaveText(["Suelta", "Leer"]);
    } finally {
      await context.close();
    }
  });

  test("with seven goals the chips wrap inside the screen and each choice is at least 32 px tall (RNP-07)", async ({
    person,
    browser,
    db,
  }) => {
    await seedGoals(db, person.id);
    const { context, page } = await open(browser, person, 360);
    try {
      await page.getByPlaceholder(FIELD).fill("Llamar al banco");
      const chips = metaGroup(page).getByRole("radio");
      await expect(chips).toHaveCount(8);
      const rows = new Set<number>();
      for (const chip of await chips.all()) {
        const box = await boxOf(chip);
        expect(box.height).toBeGreaterThanOrEqual(32);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
        rows.add(Math.round(box.y));
      }
      expect(rows.size).toBeGreaterThan(1);
      for (const chip of await cuandoGroup(page).getByRole("radio").all()) {
        expect((await boxOf(chip)).height).toBeGreaterThanOrEqual(32);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    } finally {
      await context.close();
    }
  });
  test("a past day at 360 offers no «de qué meta»", async ({ person, browser, db }) => {
    await seedGoals(db, person.id, ["Leer", "Escribir"]);
    await db`update goals.goals set created_at = now() - interval '30 days' where user_id = ${person.id}`;
    await db`update goals.commitments set created_at = now() - interval '30 days' where user_id = ${person.id}`;
    const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 360, height: 740 }, hasTouch: true });
    try {
      const page = await context.newPage();
      const yesterday = new Date(`${todayInZone()}T12:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      await page.goto(`/dia/${yesterday.toISOString().slice(0, 10)}`);
      await settled(page);
      await expect(page.getByText("Revisar leer", { exact: true })).toBeVisible();
      // A past day draws no task field at all, so there is nothing to choose a goal for.
      await expect(page.getByPlaceholder(FIELD)).toHaveCount(0);
      await expect(page.getByText(/^de qué meta$/i)).toHaveCount(0);
      await expect(metaGroup(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("at 1280", () => {
  test("nothing changes: every goal keeps its own field and the loose one keeps its words", async ({ person, browser, db }) => {
    await seedGoals(db, person.id, ["Leer", "Escribir"]);
    const { context, page } = await open(browser, person, 1280);
    try {
      await expect(page.getByLabel("Una tarea de Leer", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Una tarea de Escribir", { exact: true })).toBeVisible();
      const loose = page.getByLabel("Algo suelto", { exact: true }).locator("visible=true");
      await expect(loose).toBeVisible();
      await expect(loose).toHaveAttribute("placeholder", "Escribe algo suelto...");
      await expect(page.getByPlaceholder(FIELD).locator("visible=true")).toHaveCount(0);
      // A goal's field has the goal inside it: no «de qué meta» to choose.
      await page.getByLabel("Una tarea de Leer", { exact: true }).fill("Algo");
      await expect(cuandoGroup(page)).toBeVisible();
      await expect(page.getByText(/^de qué meta$/i)).toHaveCount(0);
      await expect(metaGroup(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
