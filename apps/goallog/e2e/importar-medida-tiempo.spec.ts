import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled as pageSettled } from "./fixtures";
import { todayInZone } from "../lib/zone";
import { movedExample, unfold } from "./importar-plan";

// RP-35, RP-66: the review names a time measure «horas y minutos», whatever unit the person wrote.
const MEASURE_LINE = "medida: horas de estudio · minutos";
const TIME_WORDS = "horas y minutos";

function shift(by: number) {
  const [year, month] = todayInZone().split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: String((index % 12) + 1).padStart(2, "0") };
}

// The catalogue's example, its dates moved to the person's now.
function template(measure: string): string {
  const text = movedExample();
  if (!text.includes(MEASURE_LINE)) throw new Error("the template example carries no `medida:` line");
  return text.replace(MEASURE_LINE, measure);
}

async function toOpenReview(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
  await unfold(page);
}

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };
async function asPerson({ person, browser, baseURL }: Fixtures, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 900 } });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const monthName = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(shift(0).year, Number(shift(0).month) - 1, 1)));
// A month's amount button: named by its month and its figure, whatever the unit the plan wrote.
const monthButton = (page: Page, amount: string) => page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${monthName}.*, ${amount}$`, "i") });

test.describe("a time measure shows as hours and minutes, never as its unit (RP-35, RP-66)", () => {
  test("a measure written in hours reads «12 h» on its month (as written), with no measure row", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, template("medida: horas de estudio · horas"));
      await expect(monthButton(page, "12 h")).toBeVisible();
      await expect(monthButton(page, "12 h")).toHaveText("12 h");
      await expect(page.getByText(TIME_WORDS, { exact: true })).toHaveCount(0);
      await expect(page.getByText("minutos", { exact: true })).toHaveCount(0);
    });
  });

  test("a measure written in minutes reads «12 h» too", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, template(MEASURE_LINE));
      await expect(monthButton(page, "12 h")).toHaveText("12 h");
      await expect(page.getByText("minutos", { exact: true })).toHaveCount(0);
    });
  });
});

// RP-66: a month's amount carries the goal's own unit; another unit is refused by name.
const kmPlan = (amount: string) =>
  `pulsar · plantilla 1\n# Correr 10K\nhorizonte: ${shift(0).year + 1}-${shift(0).month}-01\nmedida: distancia · km\n## Meses\n- ${shift(0).year}-${shift(0).month} · ${amount}`;

test.describe("a month's amount in the goal's unit (km)", () => {
  test("«8 km» passes to the review", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, kmPlan("8 km"));
      await expect(monthButton(page, "8 km")).toHaveText("8 km");
      await expect(page.getByText(TIME_WORDS, { exact: true })).toHaveCount(0);
    });
  });

  test("«8 h» is refused with the message that names «km»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill(kmPlan("8 h"));
      await page.getByRole("button", { name: "Leer el plan" }).click();
      const line = `- ${shift(0).year}-${shift(0).month} · 8 h`;
      const unitMessage = messages.errors.form.monthUnit.replaceAll("{unit}", "km");
      const expected = messages.errors.templateLine
        .replace("{line}", "6")
        .replace("{text}", line)
        .replace("{expected}", unitMessage);
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/metas\/importar$/);
    });
  });

  test("«8,5 km» is refused with the whole-number message", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill(kmPlan("8,5 km"));
      await page.getByRole("button", { name: "Leer el plan" }).click();
      const line = `- ${shift(0).year}-${shift(0).month} · 8,5 km`;
      const expected = messages.errors.templateLine
        .replace("{line}", "6")
        .replace("{text}", line)
        .replace("{expected}", messages.errors.form.monthWhole.replaceAll("{unit}", "km"));
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
    });
  });
});
