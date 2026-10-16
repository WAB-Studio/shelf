import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import messages from "../messages/es/import.json";
import roadmap from "../messages/es/roadmap.json";
import { todayInZone } from "../lib/zone";
import { test, expect, settled as pageSettled } from "./fixtures";
import { unfold } from "./importar-plan";

// 686–689, part 4: a rhythm runs from 1 minute to 744 h (31 × 24) a month, and every
// door to it — the plan's sheet, the review's sheet and the imported text — says the
// same range with the same words.

const RANGE = "El ritmo va de 1 min a 744 h al mes.";
const today = todayInZone();
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

async function seedGoal(db: postgres.Sql, personId: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm)
    values (${personId}, ${`Meta tope ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', 720)
    returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
    values (${personId}, ${goal.id}, 'Una', 60, 1, true)
  `;
  return goal.id;
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

test("the message the rhythm refuses with is the range in hours", () => {
  expect(roadmap.errors.rhythmRange).toBe(RANGE);
});

for (const width of [360, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the plan's sheet saves 744 h as 44 640 minutes", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByPlaceholder("otra").fill("744");
        await sheet.getByRole("button", { name: "Guardar el ritmo" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect.poll(async () => (await db<{ rhythm: number }[]>`select rhythm from goals.goals where id = ${goalId}`)[0].rhythm).toBe(44_640);
        await expect(page.getByText(RANGE, { exact: true })).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the plan's sheet refuses 745 h with the range, sends nothing and keeps the rhythm", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId);
      const sent: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.headers()["next-action"]) sent.push(request.url());
      });
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByPlaceholder("otra").fill("745");
        await sheet.getByRole("button", { name: "Guardar el ritmo" }).click();
        await expect(sheet.getByText(RANGE, { exact: true })).toBeVisible();
        expect(sent).toEqual([]);
        const [row] = await db<{ rhythm: number }[]>`select rhythm from goals.goals where id = ${goalId}`;
        expect(row.rhythm).toBe(720);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await drop(db, personId, goalId);
      }
    });
  });
}

function shiftYear(): { first: string; horizon: string } {
  const [year, month] = today.split("-").map(Number);
  return { first: `${year}-${String(month).padStart(2, "0")}`, horizon: `${year + 1}-${String(month).padStart(2, "0")}-01` };
}

function textWith(rhythm: string): string {
  const { first, horizon: end } = shiftYear();
  return `pulsar · plantilla 1\n\n# Ritmo tope\nhorizonte: ${end}\nmedida: horas de estudio · minutos\nritmo: ${rhythm}\n\n## Tareas\n- ${first} · 1 h · Una`;
}

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };
async function asPerson({ person, browser, baseURL }: Fixtures, width: number, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

async function read(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
}

for (const width of [360, 1440]) {
  test(`@${width}: the review's sheet takes 744 h and refuses 744 h 1 min with the range, the sheet staying open`, async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, width, async (page) => {
      await read(page, textWith("12 h"));
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
      await pageSettled(page);
      // The review arrives folded; the rhythm sits inside the goal's parts (902).
      await unfold(page);

      await page.getByRole("button", { name: "Cambiar el ritmo, 12 h al mes", exact: true }).click();
      await page.getByRole("spinbutton", { name: "horas" }).fill("744");
      await page.getByRole("spinbutton", { name: "minutos" }).fill("1");
      await page.getByRole("button", { name: "Guardar" }).click();
      await expect(page.getByText(RANGE, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toBeVisible();

      await page.getByRole("spinbutton", { name: "minutos" }).fill("0");
      await page.getByRole("button", { name: "Guardar" }).click();
      await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Cambiar el ritmo, 744 h al mes", exact: true })).toBeVisible();
    });
  });
}

test("imported text: «ritmo: 744 h» reaches the review, «ritmo: 745 h» does not", async ({ person, browser, baseURL }) => {
  await asPerson({ person, browser, baseURL }, 360, async (page) => {
    await read(page, textWith("744 h"));
    await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

    await read(page, textWith("745 h"));
    await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
    await expect(page).toHaveURL(/\/metas\/importar$/);
    await expect(page.getByLabel(messages.textLabel)).toHaveValue(textWith("745 h"));
  });
});
