import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled as pageSettled } from "./fixtures";
import { unfold } from "./importar-plan";
import { todayInZone } from "../lib/zone";

// 687, redrawn by `ImportarArbol` (RP-89): a month row is «Mes» and its amount, under a rhythm
// or not. The line «en lugar del ritmo» no longer exists; the rhythm is its own row.

const IN_LIEU = "en lugar del ritmo";
const [year, month] = todayInZone().split("-").map(Number);
const at = (by: number) => {
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};
const word = (by: number) => new Date(Date.UTC(Number(at(by).slice(0, 4)), Number(at(by).slice(5)) - 1, 1)).toLocaleDateString("es", { month: "long", timeZone: "UTC" });
const horizon = `${year + 1}-${String(month).padStart(2, "0")}-01`;

function timed(rhythm: boolean): string {
  return [
    "pulsar · plantilla 1",
    "",
    "# Con ritmo",
    `horizonte: ${horizon}`,
    "medida: horas de estudio · minutos",
    ...(rhythm ? ["ritmo: 12 h"] : []),
    "",
    "## Meses",
    `- ${at(0)} · 12 h`,
    `- ${at(1)} · 20 h`,
    "",
    "## Tareas",
    `- ${at(0)} · 4 h · Leer`,
  ].join("\n");
}

const kilometres = [
  "pulsar · plantilla 1",
  "",
  "# Correr",
  `horizonte: ${horizon}`,
  "medida: distancia · km",
  "",
  "## Meses",
  `- ${at(0)} · 30`,
].join("\n");

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
async function asPerson({ person, browser, baseURL }: Fixtures, width: number, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 1000 } });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const monthRow = (page: Page, by: number) => page.getByRole("checkbox", { name: new RegExp(`^${word(by)}`, "i") }).locator("xpath=ancestor::label");

for (const width of [360, 1440]) {
  test(`@${width}: under a rhythm each month with its own amount is «mes» and its amount, with no «en lugar del ritmo»`, async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, width, async (page) => {
      await toOpenReview(page, timed(true));
      for (const by of [0, 1]) {
        const row = monthRow(page, by);
        const line = row.getByText("mes", { exact: true });
        await expect(line).toBeVisible();
        const [name, meta] = [(await row.getByText(new RegExp(`^${word(by)}`, "i")).first().boundingBox())!, (await line.boundingBox())!];
        expect(meta.y).toBeGreaterThan(name.y);
        expect(meta.y - name.y).toBeLessThan(40);
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await expect(page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(by)}`, "i") })).toBeVisible();
      }
      await expect(page.getByText(IN_LIEU)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}

test("the rhythm's mark leaves the month rows as they are", async ({ person, browser, baseURL }) => {
  await asPerson({ person, browser, baseURL }, 390, async (page) => {
    await toOpenReview(page, timed(true));
    const box = page.getByRole("checkbox", { name: /Ritmo al mes/ });
    await box.click();
    await expect(box).not.toBeChecked();
    await expect(monthRow(page, 0).getByText("mes", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: new RegExp(`^${word(0)}`, "i") })).toBeChecked();
    await box.click();
    await expect(box).toBeChecked();
    await expect(page.getByText(IN_LIEU)).toHaveCount(0);
  });
});

test("with no ritmo: a month row is only its month and its amount", async ({ person, browser, baseURL }) => {
  await asPerson({ person, browser, baseURL }, 390, async (page) => {
    await toOpenReview(page, timed(false));
    await expect(page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(0)}`, "i") })).toBeVisible();
    await expect(page.getByText(IN_LIEU)).toHaveCount(0);
    await expect(page.getByText("Ritmo al mes", { exact: true })).toHaveCount(0);
  });
});

test("a goal that does not measure time has no rhythm to stand in for", async ({ person, browser, baseURL }) => {
  await asPerson({ person, browser, baseURL }, 390, async (page) => {
    await toOpenReview(page, kilometres);
    await expect(page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(0)}`, "i") })).toBeVisible();
    await expect(page.getByText(IN_LIEU)).toHaveCount(0);
  });
});
