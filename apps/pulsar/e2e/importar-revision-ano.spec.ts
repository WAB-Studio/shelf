import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled as pageSettled } from "./fixtures";
import { dayBefore } from "../lib/day/weeks";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";

// RP-37, RP-63, RP-67: the review of an imported plan never says a month or a
// date without its year, and says the goal's end once, in the horizon's row.
// The board is `ImportarRevisionConAño` (approved 2026-10-11, option B).

const fmt = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("es", { ...options, timeZone: "UTC" }).format(civilDateToDate(date));
const yearOf = (date: string) => date.slice(0, 4);
const monthName = (month: string) => fmt(`${month}-01`, { month: "long" });
// The board reads «octubre 2026»; the platform's long form reads «octubre de 2026». Either carries the year.
const monthYear = (month: string) => new RegExp(`^${monthName(month)}( de)? ${yearOf(month)}$`);
const monthYearIn = (month: string) => new RegExp(`${monthName(month)}( de)? ${yearOf(month)}`);
const dayLabel = (date: string) => fmt(date, { day: "numeric", month: "long", year: "numeric" });
const short = (date: string) => fmt(date, { month: "short", year: "numeric" }).replace(".", "");

const today = todayInZone();
const shift = (by: number) => {
  const [year, month] = today.split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};
const [first, second] = [shift(0), shift(1)];
const horizon = `${Number(yearOf(today)) + 1}-${today.slice(5, 7)}-01`;
const lastDay = dayBefore(horizon);
const phaseEnd = (() => {
  const date = civilDateToDate(`${shift(2)}-01`);
  date.setUTCDate(0);
  return dateToCivilDate(date);
})();

const HOURS = "Con horas";
const KM = "Con kilómetros";
const RHYTHM = "Con ritmo";

const hoursGoal = [
  `# ${HOURS}`,
  `horizonte: ${horizon}`,
  "medida: horas de estudio · minutos",
  "",
  "## Fases",
  `- ${today} a ${phaseEnd} · Fase larga`,
  "",
  "## Meses",
  `- ${first} · 12 h`,
  `- ${second} · 20 h`,
  "",
  "## Tareas",
  `- ${second} · 3 h · Comparar perfiles`,
  `- ${first} · Madre`,
  "  - 1 h · Hija",
].join("\n");

const OTHER = "Otra meta";
const otherGoal = [`# ${OTHER}`, `horizonte: ${horizon}`, "medida: horas de estudio · minutos", "", "## Meses", `- ${first} · 5 h`].join("\n");

// The template refuses a figure on a goal not measured in time, so this draft reaches the
// review as the model's would: through the tab's storage.
const kmDraft = {
  goals: [
    {
      name: KM,
      horizon,
      measure: { name: "distancia", unit: "km" },
      rhythm: null,
      phases: [],
      months: [],
      commitments: [],
      tasks: [{ month: second, name: "Tarea con tiempo", estimate: 2, children: [] }],
    },
  ],
};

const rhythmGoal = [
  `# ${RHYTHM}`,
  `horizonte: ${horizon}`,
  "medida: horas de estudio · minutos",
  "ritmo: 12 h",
  "",
  "## Meses",
  `- ${first} · 12 h`,
  `- ${second} · 20 h`,
  "",
  "## Tareas",
  `- ${first} · 4 h · Leer`,
  `- ${first} · Tutor`,
  "  - 1 h · Elegir tutor",
].join("\n");

async function toDraftReview(page: Page) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.evaluate(
    (stored) => sessionStorage.setItem("pulsar.import-draft", JSON.stringify(stored)),
    { via: "model", draft: kmDraft, source: null, sourceName: null, unmarked: null },
  );
  await page.goto("/metas/importar/revisar");
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
}

const plan = (...goals: string[]) => ["pulsar · plantilla 1", "", goals.join("\n\n")].join("\n");

async function toReview(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
}

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };
async function asPerson({ person, browser, baseURL }: Fixtures, width: number, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 1000 } });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const card = (page: Page, name: string) => page.getByRole("region", { name });
const row = (scope: ReturnType<typeof card>, text: string) => scope.locator("label").filter({ hasText: text }).first();

test.describe("the review always says the year (RP-37)", () => {
  for (const width of [360, 1280]) {
    test(`@${width}: the goal opens «Desde el ${dayLabel(today)}» and the end date is said once, in the horizon's row`, async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, width, async (page) => {
        await toReview(page, plan(hoursGoal));
        const goal = card(page, HOURS);
        const span = goal.locator("p").filter({ hasText: "Desde el" });
        await expect(span).toHaveCount(1);
        await expect(span).toContainText(`Desde el ${dayLabel(today)}`);
        await expect(span).not.toContainText(dayLabel(lastDay));
        await expect(goal.getByText(dayLabel(lastDay))).toHaveCount(1);
        await expect(row(goal, messages.review.horizon)).toContainText(dayLabel(lastDay));
      });
    });
  }

  test("«## Meses» names each month with its year", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal));
      const goal = card(page, HOURS);
      for (const month of [first, second]) {
        const months = goal.getByRole("checkbox", { name: new RegExp(`^${monthName(month)}( de)? ${yearOf(month)}`) });
        await expect(months).toHaveCount(1);
        await expect(row(goal, `${monthName(month)}`).getByText(monthYear(month))).toHaveCount(1);
      }
    });
  });

  test("a task reads its month with the year, a parent too: «<mes año> · la suma de lo marcado»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal));
      const goal = card(page, HOURS);
      await expect(row(goal, "Comparar perfiles").getByText(monthYear(second))).toBeVisible();
      await expect(row(goal, "Madre").getByText(new RegExp(`^${monthName(first)}( de)? ${yearOf(first)} · ${messages.review.sumOfMarked.split("· ")[1]}$`))).toBeVisible();
    });
  });

  test("a figure the goal cannot keep says «<mes año> · se crea sin cifra»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toDraftReview(page);
      const warning = new RegExp(`^${monthName(second)}( de)? ${yearOf(second)} · ${messages.notices.estimateDroppedNotTime}$`);
      await expect(card(page, KM).getByText(warning)).toBeVisible();
    });
  });

  test("a phase names the year at both ends, also when it does not cross a year", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal));
      await expect(card(page, HOURS).getByText(`${short(today)}–${short(phaseEnd)}`, { exact: true })).toBeVisible();
    });
  });

  test("a goal with rhythm keeps «va al plan» and «en lugar del ritmo», its months and the start with their year", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(rhythmGoal));
      const goal = card(page, RHYTHM);
      await expect(row(goal, "Leer").getByText("va al plan", { exact: true })).toBeVisible();
      await expect(row(goal, "Tutor").getByText("la suma de lo marcado", { exact: true })).toBeVisible();
      await expect(goal.getByText("en lugar del ritmo", { exact: true })).toHaveCount(2);
      await expect(goal.getByText(monthYear(first))).toHaveCount(1);
      await expect(goal.getByText(monthYear(second))).toHaveCount(1);
      await expect(goal.locator("p").filter({ hasText: `Desde el ${dayLabel(today)}` })).toHaveCount(1);
      // The task rows promise no month under a rhythm.
      await expect(row(goal, "Leer").getByText(monthYearIn(first))).toHaveCount(0);
    });
  });
});

test.describe("the review fits", () => {
  test("at 360 two goals leave no sideways scroll", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal, otherGoal));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    });
  });

  test("at 1024 two goals lay out as at 1280: each goal's card is not squeezed to a sliver", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 1024, async (page) => {
      await toReview(page, plan(hoursGoal, otherGoal));
      for (const name of [HOURS, OTHER]) {
        expect((await card(page, name).boundingBox())!.width).toBeGreaterThanOrEqual(240);
      }
    });
  });

  test("at 1024 two goals: no word breaks letter by letter, no sideways scroll", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 1024, async (page) => {
      await toReview(page, plan(hoursGoal, otherGoal));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
      // A word split over two lines has two client rects.
      const broken = await page.evaluate(() => {
        const found: string[] = [];
        const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? "";
          for (const match of text.matchAll(/\S{4,}/g)) {
            const range = document.createRange();
            range.setStart(node, match.index!);
            range.setEnd(node, match.index! + match[0].length);
            if (range.getClientRects().length > 1) found.push(match[0]);
          }
        }
        return found;
      });
      expect(broken).toEqual([]);
    });
  });
});
