import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled as pageSettled } from "./fixtures";
import { dayBefore } from "../lib/day/weeks";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { rawGoal, rawTask, seedOf, stored } from "./importar-plan";

// RP-37, RP-63, RP-67: the review of an imported plan never says a month or a
// date without its year, and says the goal's end once, in the horizon's row.
// The board is `ImportarRevisionConAño` (approved 2026-10-11, option B).

const fmt = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("es", { ...options, timeZone: "UTC" }).format(civilDateToDate(date));
const yearOf = (date: string) => date.slice(0, 4);
const monthName = (month: string) => fmt(`${month}-01`, { month: "long" });

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

// The template refuses a figure on a goal not measured in time, so this draft reaches the
// review as the model's would: through the tab's storage.
async function toDraftReview(page: Page) {
  const seeded = stored(
    seedOf([
      rawGoal(KM, {
        horizon,
        measure: { name: "distancia", unit: "km" },
        tasks: [rawTask("Tarea con tiempo", { month: second, estimate: 2 })],
      }),
    ]),
  );
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.evaluate((value) => sessionStorage.setItem("pulsar.import-draft", value), JSON.stringify(seeded));
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

const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const dayShort = (date: string) => `${Number(date.slice(8, 10))} ${ABBR[Number(date.slice(5, 7)) - 1]} ${yearOf(date)}`;
// A month row says its month, and its year only when it is not this one's.
const rowName = (month: string) => {
  const name = monthName(month);
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return yearOf(month) === yearOf(today) ? cap : `${cap} ${yearOf(month)}`;
};
const rowOf = (page: Page, name: RegExp) => page.locator("div").filter({ has: page.getByRole("checkbox", { name }) }).last().locator("label");

test.describe("the review says the year where the plan needs it (RP-37)", () => {
  for (const width of [360, 1280]) {
    test(`@${width}: the goal's end is said once, with its year, in the goal's own row`, async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, width, async (page) => {
        await toReview(page, plan(hoursGoal));
        await expect(page.getByText(`hasta el ${dayShort(lastDay)}`)).toHaveCount(1);
        await expect(rowOf(page, new RegExp(`^${HOURS}`))).toContainText(`hasta el ${dayShort(lastDay)}`);
        await expect(page.getByText(dayShort(lastDay), { exact: false })).toHaveCount(1);
        await expect(page.getByText(/^Desde el/)).toHaveCount(0);
      });
    });
  }

  test("«## Meses» names each month, with its year when it is not this one's", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal));
      for (const month of [first, second]) {
        await expect(page.getByRole("checkbox", { name: new RegExp(`^${rowName(month)}`) })).toHaveCount(1);
        await expect(rowOf(page, new RegExp(`^${rowName(month)}`))).toContainText("mes");
      }
    });
  });

  test("a task reads «tarea» and its month, a parent too", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal));
      await expect(rowOf(page, /^Comparar perfiles/)).toContainText(`tarea · ${monthName(second)}`);
      await expect(rowOf(page, /^Madre/)).toContainText(`tarea · ${monthName(first)}`);
    });
  });

  test("a figure the goal cannot keep says «tarea · <mes> · se crea sin cifra»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toDraftReview(page);
      await expect(page.getByText(`tarea · ${monthName(second)} · ${messages.notices.estimateDroppedNotTime}`, { exact: true })).toBeVisible();
    });
  });

  test("a phase names its two days, each with its year, also when it does not cross a year", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(hoursGoal));
      await expect(page.getByText(`fase · ${dayShort(today)} – ${dayShort(phaseEnd)}`, { exact: true })).toBeVisible();
    });
  });

  test("a goal with rhythm: its task rows say their month, the months say «mes», none says «va al plan»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 360, async (page) => {
      await toReview(page, plan(rhythmGoal));
      await expect(rowOf(page, /^Leer/)).toContainText(`tarea · ${monthName(first)}`);
      await expect(rowOf(page, /^Tutor/)).toContainText(`tarea · ${monthName(first)}`);
      await expect(rowOf(page, new RegExp(`^${rowName(first)}`))).toContainText("mes");
      await expect(page.getByText(/va al plan|en lugar del ritmo|la suma de lo marcado/)).toHaveCount(0);
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

  test("at 1024 two goals lay out as at 1280: the tree's one card is not squeezed to a sliver", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, 1024, async (page) => {
      await toReview(page, plan(hoursGoal, otherGoal));
      expect((await page.getByRole("region", { name: messages.review.title }).boundingBox())!.width).toBeGreaterThanOrEqual(240);
      for (const name of [HOURS, OTHER]) await expect(page.getByRole("checkbox", { name: new RegExp(`^${name}`) })).toBeVisible();
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
