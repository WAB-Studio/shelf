import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";
import { dayBefore } from "../lib/day/weeks";
import { civilDateToDate, todayInZone } from "../lib/zone";

// Against the ordinary server, which holds no model key (`OPENAI_API_KEY=""`):
// the draft comes from the template path, so no model is ever called
// (RP-37, RNP-13). The boards are `ImportarRevisar*.dc.html`.

function monthsFromToday() {
  const [year, month] = todayInZone().split("-").map(Number);
  const shift = (by: number) => {
    const index = year * 12 + (month - 1) + by;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  };
  return { previous: shift(-1), first: shift(0), second: shift(1), horizon: `${year + 1}-${String(month).padStart(2, "0")}-01` };
}

const word = (month: string, withYear = false) =>
  new Intl.DateTimeFormat("es", withYear ? { month: "long", year: "numeric", timeZone: "UTC" } : { month: "long", timeZone: "UTC" }).format(
    civilDateToDate(`${month}-01`),
  );

// The catalogue's example, its dates moved to the person's own now so the
// months stay inside the goal's span whatever day the suite runs.
function template(extraMonth?: string): string {
  const { first, second, horizon } = monthsFromToday();
  let text = messages.template.example
    .replace("2027-10-01", horizon)
    .replace("2026-10-01 a 2026-12-31", `${first}-01 a ${first}-28`)
    .replaceAll("2026-10", first)
    .replaceAll("2026-11", second);
  if (extraMonth) text = text.replace(`- ${second} · 20 h`, `- ${second} · 20 h\n- ${extraMonth} · 8 h`);
  return text;
}

async function toReview(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await settled(page);
}

// `load` fires with the loading fallback still standing.
async function settled(page: Page) {
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
}

// The worker's own person drives each test, so what the database holds is theirs alone.
type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };
async function asPerson(
  { person, browser, baseURL }: Fixtures,
  run: (page: Page) => Promise<void>,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, ...(viewport ? { viewport } : {}) });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const dayWord = (date: string) =>
  new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(civilDateToDate(date));

// A goal that measures nothing: its month amount and its task's time cannot be kept.
function noMeasureTemplate(): string {
  const { first, horizon } = monthsFromToday();
  return `pulsar · plantilla 1\n\n# Trámites\nhorizonte: ${horizon}\n\n## Meses\n- ${first} · 3\n\n## Tareas\n- ${first} · 2 · Comprar tenis`;
}

// The header's way back: «Volver a {place}».
const backName = `Volver a ${messages.review.place}`;

const box = (page: Page, name: string | RegExp) => page.getByRole("checkbox", { name });

test.describe("the review of an imported plan (RP-37, RP-35)", () => {
  test("it reads the goal, its amounts, its commitments and the tutor task with its two sub-tasks", async ({ person, browser, baseURL }) => {
    const { first, second } = monthsFromToday();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template());

      await expect(page.getByText(messages.review.eyebrowTemplate, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "IA aplicada" })).toBeVisible();
      await expect(page.getByRole("button", { name: `Cambiar el monto de ${word(first)}` })).toHaveText("12 h");
      await expect(page.getByRole("button", { name: `Cambiar el monto de ${word(second)}` })).toHaveText("20 h");
      await expect(box(page, /Tema técnico/)).toBeChecked();
      await expect(box(page, /Inglés pasivo/)).toBeChecked();
      await expect(box(page, /^Tutor/)).toBeChecked();
      await expect(box(page, /Elegir tutor/)).toBeChecked();
      await expect(box(page, /Sesiones 1–4/)).toBeChecked();
      // The template carries a rhythm, so the month only orders the plan: the line is the sum alone.
      await expect(page.getByText("la suma de lo marcado", { exact: true })).toBeVisible();
      await expect(page.getByText(`${word(first, true)} · la suma de lo marcado`, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Crear 1 meta" })).toBeVisible();
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveCount(0);
    });
  });

  test("a commitment whose days come out of order is read Monday first with «y» before the last", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = template().replace("- Tema técnico · martes y jueves · 2 h", "- Tema técnico · domingo, miércoles y lunes · 2 h");
      expect(text).toContain("domingo, miércoles y lunes");
      await toReview(page, text);

      await expect(box(page, /Tema técnico/)).toHaveAccessibleName("Tema técnico lunes, miércoles y domingo 2 h");
    });
  });

  test("unmarking a sub-task and changing a month, then confirming, writes exactly that", async ({ person, browser, baseURL, db }) => {
    const { first, second } = monthsFromToday();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template());

      await box(page, /Sesiones 1–4/).uncheck();
      // The parent's figure is the sum of what stays marked.
      await expect(page.locator("label", { hasText: "la suma de lo marcado" })).toContainText("1 h");

      await page.getByRole("button", { name: `Cambiar el monto de ${word(first)}` }).click();
      await page.getByRole("spinbutton", { name: "horas" }).fill("10");
      await page.getByRole("spinbutton", { name: "minutos" }).fill("0");
      await page.getByRole("button", { name: "Guardar" }).click();
      await expect(page.getByRole("button", { name: `Cambiar el monto de ${word(first)}` })).toHaveText("10 h");

      await page.getByRole("button", { name: "Crear 1 meta" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      await expect(page.getByText("IA aplicada").first()).toBeVisible();
      // The revalidated page has painted: the review's refresh is over, and the person never goes back to the import.
      await expect(page.getByRole("link", { name: /IA aplicada/ }).first()).toBeVisible();
      await expect(page).toHaveURL(/\/metas$/);

      const goals = await db`select id from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
      expect(goals).toHaveLength(1);
      const budgets = await db`
        select to_char(month, 'YYYY-MM') as month, amount from goals.month_budgets
        where user_id = ${person.id} and goal_id = ${goals[0].id} order by month`;
      expect(budgets.map((row) => [row.month, row.amount])).toEqual([[first, 600], [second, 1200]]);

      const tutor = await db`select id from goals.one_offs where user_id = ${person.id} and goal_id = ${goals[0].id} and name = 'Tutor' and parent_id is null`;
      expect(tutor).toHaveLength(1);
      const children = await db`select name, estimate from goals.one_offs where user_id = ${person.id} and parent_id = ${tutor[0].id}`;
      expect(children.map((row) => [row.name, row.estimate])).toEqual([["Elegir tutor", 60]]);
      const unmarked = await db`select 1 from goals.one_offs where user_id = ${person.id} and name = 'Sesiones 1–4'`;
      expect(unmarked).toHaveLength(0);
    });
  });

  test("a month before today is shown under the warnings, unmarked, and is not written", async ({ person, browser, baseURL, db }) => {
    const { previous, first, second } = monthsFromToday();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template(previous));

      const title = page.getByRole("heading", { name: messages.review.blocked.title });
      await expect(title).toBeVisible();
      await expect(page.getByText(messages.review.blocked.hint, { exact: true })).toBeVisible();
      const refused = page.getByRole("checkbox", { name: new RegExp(word(previous, true)) });
      await expect(refused).toBeDisabled();
      await expect(refused).not.toBeChecked();
      await expect(
        page.getByText(messages.review.blocked.monthBeforeStart.replace("{first}", word(first)), { exact: true }),
      ).toBeVisible();
      // The warnings stand above the goal.
      const above = (await title.boundingBox())!.y;
      expect(above).toBeLessThan((await page.getByRole("heading", { name: "IA aplicada" }).boundingBox())!.y);

      await page.getByRole("button", { name: "Crear 1 meta" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const goals = await db`select id from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
      const budgets = await db`
        select to_char(month, 'YYYY-MM') as month from goals.month_budgets
        where user_id = ${person.id} and goal_id = ${goals[0].id} order by month`;
      expect(budgets.map((row) => row.month)).toEqual([first, second]);
    });
  });

  test("a reload keeps the draft, and none sends the person back to the import", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template());
      await page.reload();
      await settled(page);
      await expect(page.getByRole("heading", { name: "IA aplicada" })).toBeVisible();
    });
    await asPerson({ person, browser, baseURL }, async (fresh) => {
      await fresh.goto("/metas/importar/revisar");
      await expect(fresh).toHaveURL(/\/metas\/importar$/);
    });
  });

  test("the goal's last day is the day before its horizon, and a month names the right reason", async ({ person, browser, baseURL }) => {
    const { previous, first, horizon } = monthsFromToday();
    const last = dayBefore(horizon);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template(horizon.slice(0, 7)).replace("- " + horizon.slice(0, 7) + " · 8 h", `- ${horizon.slice(0, 7)} · 8 h\n- ${previous} · 5 h`));

      await expect(page.getByText(`hasta el ${dayWord(last)}`, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.review.blocked.monthAfterEnd.replace("{last}", dayWord(last)), { exact: true })).toBeVisible();
      await expect(
        page.getByText(messages.review.blocked.monthBeforeStart.replace("{first}", word(first)), { exact: true }),
      ).toBeVisible();
    });
  });

  test("a task in a goal that measures nothing is kept, without time, and written with a null estimate", async ({ person, browser, baseURL, db }) => {
    const { first } = monthsFromToday();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, noMeasureTemplate());

      await expect(page.getByText(messages.review.blocked.amountNoMeasure, { exact: true })).toBeVisible();
      const task = box(page, /Comprar tenis/);
      await expect(task).toBeChecked();
      await expect(task).toBeEnabled();
      await expect(page.getByText(`${word(first, true)} · ${messages.notices.estimateDropped}`, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Cambiar el monto de Comprar tenis/ })).toHaveCount(0);

      await page.getByRole("button", { name: "Crear 1 meta" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await db`select estimate from goals.one_offs where user_id = ${person.id} and name = 'Comprar tenis'`;
      expect(rows).toHaveLength(1);
      expect(rows[0].estimate).toBeNull();
    });
  });

  test("an unmarked sub-task and a changed month survive a reload, and the way back leads to the text", async ({ person, browser, baseURL }) => {
    const { first } = monthsFromToday();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template());
      await page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(first)}`) }).click();
      await page.getByRole("spinbutton", { name: "horas" }).fill("10");
      await page.getByRole("spinbutton", { name: "minutos" }).fill("0");
      await page.getByRole("button", { name: "Guardar" }).click();
      await page.reload();
      await settled(page);
      await expect(page.getByRole("button", { name: `Cambiar el monto de ${word(first)}, 10 h` })).toHaveText("10 h");

      await box(page, /Sesiones 1–4/).uncheck();
      await page.reload();
      await settled(page);
      await expect(box(page, /Sesiones 1–4/)).not.toBeChecked();
      await expect(box(page, /Elegir tutor/)).toBeChecked();
      await expect(page.getByRole("button", { name: `Cambiar el monto de ${word(first)}, 10 h` })).toHaveText("10 h");

      await page.getByRole("link", { name: backName, exact: true }).click();
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(template());
    });
  });

  test("an amount button is one button named by its item, and no checkbox takes the amount", async ({ person, browser, baseURL }) => {
    const { first } = monthsFromToday();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template());
      await expect(page.getByRole("button", { name: `Cambiar el monto de ${word(first)}, 12 h` })).toHaveCount(1);
      await expect(page.getByRole("link", { name: backName, exact: true })).toBeVisible();
      // RP-63: the goal's rhythm row is the one checkbox that says «12 h», as «12 h al mes»; no month's amount is.
      const rhythm = messages.review.rhythmOf.replace("{amount}", "12 h");
      for (const checkbox of await page.getByRole("checkbox").all()) {
        const label = await checkbox.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? "");
        if (label.startsWith(rhythm)) continue;
        expect(label).not.toContain("12 h");
      }
      await expect(page.getByRole("checkbox", { name: /12 h/ })).toHaveCount(1);
    });
  });

  test("a goal an open goal already names starts unmarked with a warning, and marking it writes a second", async ({ person, browser, baseURL, db }) => {
    const { horizon } = monthsFromToday();
    await db`insert into goals.goals (user_id, name, horizon) values (${person.id}, 'IA aplicada', ${horizon})`;
    await db`insert into goals.goals (user_id, name, horizon, archived_at) values (${person.id}, 'Trámites', ${horizon}, now())`;
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, template());

      await expect(page.getByRole("note").filter({ hasText: messages.review.repeated })).toBeVisible();
      await expect(box(page, /Tema técnico/)).not.toBeChecked();
      await expect(box(page, /Elegir tutor/)).not.toBeChecked();
      const none = page.getByRole("button", { name: "Crear 0 metas" });
      await expect(none).toBeDisabled();

      await box(page, new RegExp(`^${messages.review.horizonUntil.replace("{date}", ".*")}`)).check();
      await expect(page.getByRole("note")).toHaveCount(1);
      await page.getByRole("button", { name: "Crear 1 meta" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const goals = await db`select 1 from goals.goals where user_id = ${person.id} and name = 'IA aplicada' and archived_at is null`;
      expect(goals).toHaveLength(2);
    });
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, noMeasureTemplate());
      await expect(page.getByRole("note")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Crear 1 meta" })).toBeEnabled();
    });
  });

  for (const width of [360, 1280]) {
    test(`it holds at ${width}`, async ({ person, browser, baseURL }) => {
      await asPerson(
        { person, browser, baseURL },
        async (page) => {
          await toReview(page, template());

          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          for (const checkbox of await page.getByRole("checkbox").all()) {
            const row = (await checkbox.locator("xpath=ancestor::label").boundingBox())!;
            expect(row.height).toBeGreaterThanOrEqual(44);
          }
          const amounts = await page.getByRole("button", { name: /^Cambiar el monto de/ }).all();
          expect(amounts.length).toBeGreaterThan(0);
          for (const amount of amounts) expect((await amount.boundingBox())!.height).toBeGreaterThanOrEqual(44);

          // The confirm stays in the viewport while the list scrolls.
          const at = (await page.getByRole("button", { name: "Crear 1 meta" }).boundingBox())!;
          expect(at.y + at.height).toBeLessThanOrEqual(800);
          // A sub-task sits 32px in.
          const parent = (await box(page, /^Tutor/).boundingBox())!;
          const child = (await box(page, /Elegir tutor/).boundingBox())!;
          expect(child.x - parent.x).toBeGreaterThanOrEqual(28);
        },
        { width, height: 800 },
      );
    });
  }

  for (const width of [360, 390, 1280, 1440]) {
    test(`its header and its text hold at ${width}`, async ({ person, browser, baseURL }) => {
      await asPerson(
        { person, browser, baseURL },
        async (page) => {
          const text = template();
          await toReview(page, text);

          await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
          await expect(page.getByRole("link", { name: backName, exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

          const source = page.getByRole("textbox", { name: messages.review.sourceLabel, exact: true });
          if (width >= 1024) {
            await expect(source).toBeVisible();
            await expect(source).toHaveValue(text);
            await expect(page.getByRole("link", { name: messages.review.change, exact: true })).toBeVisible();
            const left = (await source.boundingBox())!;
            const right = (await page.getByRole("heading", { name: "IA aplicada" }).boundingBox())!;
            expect(left.x + left.width).toBeLessThanOrEqual(right.x);
            expect(Math.abs(left.y - right.y)).toBeLessThan(400);
          } else {
            await expect(source).toHaveCount(0);
            await expect(page.getByRole("link", { name: messages.review.change, exact: true })).toHaveCount(0);
          }
        },
        { width, height: 900 },
      );
    });
  }

  test("at 1440 two goals' cards sit side by side, and a file import shows its name where the text would be", async ({ person, browser, baseURL }) => {
    const { horizon } = monthsFromToday();
    const two = `${template()}\n\n# Trámites\nhorizonte: ${horizon}\n\n## Compromisos\n- Pagar la luz · cada día · toque`;
    await asPerson(
      { person, browser, baseURL },
      async (page) => {
        await toReview(page, two);
        const first = (await page.getByRole("region", { name: "IA aplicada" }).boundingBox())!;
        const second = (await page.getByRole("region", { name: "Trámites" }).boundingBox())!;
        expect(Math.abs(first.y - second.y)).toBeLessThan(2);
        expect(second.x).toBeGreaterThan(first.x + first.width - 1);

        await page.goto("/metas/importar");
        await page.getByLabel(messages.upload).setInputFiles({ name: "mi-plan.txt", mimeType: "text/plain", buffer: Buffer.from(template()) });
        await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
        await settled(page);
        await expect(page.getByText(messages.review.sourceFile.replace("{name}", "mi-plan.txt"), { exact: true })).toBeVisible();
        expect(await page.getByText(messages.review.sourceFile.replace("{name}", "mi-plan.txt"), { exact: true }).evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
        await expect(page.getByRole("textbox", { name: messages.review.sourceLabel })).toHaveCount(0);
      },
      { width: 1440, height: 900 },
    );
  });

  for (const width of [360, 1280]) {
    test(`its provenance is the header's one eyebrow and its sentences read in Archivo at ${width}`, async ({ person, browser, baseURL }) => {
      await asPerson(
        { person, browser, baseURL },
        async (page) => {
          await toReview(page, template());
          const header = page.locator("main > header");
          await expect(header.getByText(messages.review.eyebrowTemplate, { exact: true })).toBeVisible();
          await expect(page.locator("main > :not(header)").getByText(messages.review.eyebrowTemplate, { exact: true })).toHaveCount(0);
          const hint = page.getByText(messages.review.hint, { exact: true });
          expect(await hint.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
        },
        { width, height: 800 },
      );
    });
  }
});
