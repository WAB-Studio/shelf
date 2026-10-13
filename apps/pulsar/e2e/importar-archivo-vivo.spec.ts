import type { Browser, Locator, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { todayInZone } from "../lib/zone";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";

// Module 819. Board `ImportarArchivoYAviso` (RP-37, RP-72): a text file whose reading lists template errors
// lands in the box and is corrected there like a pasted text; a text that stops being a template says so.

function shift(by: number) {
  const [year, month] = todayInZone().split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: String((index % 12) + 1).padStart(2, "0") };
}
const M1 = `${shift(0).year}-${shift(0).month}`;
const M2 = `${shift(1).year}-${shift(1).month}`;
const HORIZON = `${shift(0).year + 1}-${shift(0).month}-17`;

const FILE_NOTE = "Leído de plan.md. Corrige aquí y vuelve a leer.";
const NOT_TEMPLATE =
  "Ya no es la plantilla: la primera línea no empieza por «pulsar ·». «Leer el plan» lo mandará a la IA.";
const AI_SHUT = "La lectura con IA no está disponible ahora.";
const FIRST = "pulsar · plantilla 1";

const MONTH_BAD = `- ${M2} · 8 h`;
const MONTH_OK = `- ${M2} · 8 km`;
const SERIES_BAD = "- Series · martes · 30 min";
const SERIES_OK = "- Series · martes · 5 km";
const TASK_BAD = `- ${M1} · 2 h · Comprar zapatillas`;
const TASK_OK = `- ${M1} · Comprar zapatillas`;

function plan(o: { month?: string; series?: string; task?: string } = {}) {
  return [
    FIRST,
    "",
    "# Correr 10K",
    `horizonte: ${HORIZON}`,
    "medida: distancia · km",
    "",
    "## Meses",
    `- ${M1} · 40 km`,
    o.month ?? MONTH_BAD,
    "",
    "## Compromisos",
    "- Fondo · sábado · 8 km",
    o.series ?? SERIES_BAD,
    "",
    "## Tareas",
    o.task ?? TASK_BAD,
    `- ${M2} · Inscribirme a la carrera`,
  ].join("\n");
}
const FIXED = plan({ month: MONTH_OK, series: SERIES_OK, task: TASK_OK });
const WITHOUT_FIRST = plan().split("\n").slice(1).join("\n");
const lineOf = (text: string, written: string) => text.split("\n").indexOf(written) + 1;

const VIEWPORT = { width: 390, height: 844 };

async function asPerson(
  { person, browser, baseURL }: { person: { sessionFile: string }; browser: Browser; baseURL: string | undefined },
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: VIEWPORT });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const boxOf = (page: Page) => page.getByLabel(messages.textLabel);
const alertOf = (page: Page) => appAlerts(page).filter({ hasText: /\S/ });
const rowsOf = (alert: Locator) => alert.getByRole("button");
const count = (n: number) => `${n} líneas por corregir`;
const listOf = (page: Page) => alertOf(page).filter({ hasText: "líneas por corregir" });

function watchRoute(page: Page) {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/importar/leer")) hits.push(r.method());
  });
  return hits;
}

async function open(page: Page) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await pageSettled(page);
}

async function upload(page: Page, text = plan(), name = "plan.md") {
  await open(page);
  await page.getByLabel(messages.upload).setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(text) });
  await page.getByRole("button", { name: messages.read }).click();
  await expect(page.getByText(count(3), { exact: true })).toBeVisible();
}

const selected = (box: Locator) =>
  box.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));

test.describe("a file's template errors are corrected in the box (board ImportarArchivoYAviso)", () => {
  test("state 1: the file's text is in the box, the note names the file and sits between the box and the list", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page);
      await boxOf(page).fill("Quiero correr más este año.");
      await upload(page);
      await expect(boxOf(page)).toHaveValue(plan());
      await expect(boxOf(page)).toHaveAttribute("aria-invalid", "true");
      await expect(rowsOf(listOf(page))).toHaveCount(3);
      const note = page.getByText(FILE_NOTE, { exact: true });
      await expect(note).toBeVisible();
      const y = async (l: Locator) => (await l.boundingBox())!.y;
      expect(await y(note)).toBeGreaterThan(await y(boxOf(page)));
      expect(await y(note)).toBeLessThan(await y(listOf(page)));
    });
  });

  test("state 2: tapping a row selects that line in the box", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      for (const bad of [TASK_BAD, SERIES_BAD, MONTH_BAD]) {
        await rowsOf(listOf(page)).filter({ hasText: `Línea ${lineOf(plan(), bad)}:` }).click();
        expect(await selected(boxOf(page))).toBe(bad);
      }
    });
  });

  test("state 3: fixing a line in the box drops its row and the count, with no request to the route", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      const hits = watchRoute(page);
      await boxOf(page).fill(plan({ series: SERIES_OK }));
      const list = listOf(page);
      await expect(list.getByText(count(2), { exact: true })).toBeVisible();
      await expect(rowsOf(list)).toHaveCount(2);
      const whole = (await list.textContent()) ?? "";
      expect(whole).not.toContain(`Línea ${lineOf(plan(), SERIES_BAD)}:`);
      expect(whole).toContain(`Línea ${lineOf(plan(), MONTH_BAD)}:`);
      await expect(page.getByText(FILE_NOTE, { exact: true })).toBeVisible();
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toHaveCount(0);
      expect(hits).toEqual([]);
    });
  });

  test("state 3b: with every line fixed the list, the note and the mark go, and «Leer el plan» leads to the review", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      await boxOf(page).fill(FIXED);
      await expect(page.getByText("líneas por corregir")).toHaveCount(0);
      await expect(page.getByText(FILE_NOTE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toHaveCount(0);
      await expect(boxOf(page)).not.toHaveAttribute("aria-invalid", "true");
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
    });
  });

  test("state 4: deleting line 1 removes the list, the note and the mark, and says it is no longer the template", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      const hits = watchRoute(page);
      await boxOf(page).fill(WITHOUT_FIRST);
      const notice = page.getByText(NOT_TEMPLATE, { exact: true });
      await expect(notice).toBeVisible();
      await expect(page.getByText("líneas por corregir")).toHaveCount(0);
      await expect(page.getByText(FILE_NOTE, { exact: true })).toHaveCount(0);
      await expect(boxOf(page)).not.toHaveAttribute("aria-invalid", "true");
      await expect(boxOf(page)).toHaveValue(WITHOUT_FIRST);
      expect(hits).toEqual([]);
    });
  });

  test("state 5: restoring line 1 brings the list and the note back and takes the notice away", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      await boxOf(page).fill(WITHOUT_FIRST);
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toBeVisible();
      const hits = watchRoute(page);
      await boxOf(page).fill(plan());
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toHaveCount(0);
      await expect(listOf(page).getByText(count(3), { exact: true })).toBeVisible();
      await expect(rowsOf(listOf(page))).toHaveCount(3);
      await expect(page.getByText(FILE_NOTE, { exact: true })).toBeVisible();
      await expect(boxOf(page)).toHaveAttribute("aria-invalid", "true");
      expect(hits).toEqual([]);
    });
  });

  test("state 6: with the model shut, «Leer el plan» on the no-longer-template text answers once, with the shut notice and no second one", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      await boxOf(page).fill(WITHOUT_FIRST);
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toBeVisible();
      await page.route("**/importar/leer", (route) =>
        route.fulfill({ status: 503, json: { error: "import.errors.noKey" } }),
      );
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(appAlerts(page).filter({ hasText: AI_SHUT })).toHaveCount(1);
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toHaveCount(0);
      await expect(alertOf(page)).toHaveCount(1);
      await expect(boxOf(page)).toHaveValue(WITHOUT_FIRST);
    });
  });

  test("a file is read once: the box is disabled while it reads and the text arrives with the answer", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/importar/leer", async (route) => {
        await gate;
        await route.continue();
      });
      await page.getByLabel(messages.upload).setInputFiles({ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from(plan()) });
      await page.getByRole("button", { name: messages.read }).click();
      await expect(boxOf(page)).toBeDisabled();
      await expect(page.getByText("líneas por corregir")).toHaveCount(0);
      release();
      await expect(boxOf(page)).toBeEnabled();
      await expect(listOf(page).getByText(count(3), { exact: true })).toBeVisible();
      await expect(boxOf(page)).toHaveValue(plan());
    });
  });

  test("state 7: a PDF or an image that fails leaves the box as it was, with no file note", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.route("**/importar/leer", (route) =>
        route.fulfill({
          status: 422,
          json: { error: "import.errors.templateLine", errors: [{ line: 1, expected: "import.errors.form.goal" }] },
        }),
      );
      await open(page);
      await boxOf(page).fill("Quiero correr más este año.");
      for (const file of [
        { name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n${FIXED}`) },
        { name: "plan.png", mimeType: "image/png", buffer: Buffer.from(`${plan()}`) },
      ]) {
        const answered = page.waitForResponse("**/importar/leer");
        await page.getByLabel(messages.upload).setInputFiles(file);
        await page.getByRole("button", { name: messages.read }).click();
        await answered;
        await expect(boxOf(page)).toHaveValue("Quiero correr más este año.");
        await expect(page.getByText(/Leído de/)).toHaveCount(0);
        await page.getByRole("button", { name: messages.remove }).click();
      }
    });
  });
  test("a second reading that fails with template errors drops the first file's note", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      await expect(page.getByText(FILE_NOTE, { exact: true })).toBeVisible();
      await boxOf(page).fill(plan({ series: SERIES_OK }));
      await expect(listOf(page).getByText(count(2), { exact: true })).toBeVisible();
      const answered = page.waitForResponse("**/importar/leer");
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await answered;
      await expect(listOf(page).getByText(count(2), { exact: true })).toBeVisible();
      await expect(page.getByText(FILE_NOTE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(/Leído de/)).toHaveCount(0);
    });
  });

  test("emptying the box entirely after a template failure shows neither the list nor the no-longer-template notice", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await upload(page);
      await boxOf(page).fill("");
      await expect(page.getByText("líneas por corregir")).toHaveCount(0);
      await expect(page.getByText(NOT_TEMPLATE, { exact: true })).toHaveCount(0);
      await expect(boxOf(page)).not.toHaveAttribute("aria-invalid", "true");
    });
  });
});
