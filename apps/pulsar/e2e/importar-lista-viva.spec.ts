import type { Browser, Locator, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { todayInZone } from "../lib/zone";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";

// Module 808. Board `ImportarErroresVivos` (RP-72, RP-37): after a reading with errors, every change to the
// text re-reads the template in the browser, with no request. The first reading is the route's.

function shift(by: number) {
  const [year, month] = todayInZone().split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: String((index % 12) + 1).padStart(2, "0") };
}
const M1 = `${shift(0).year}-${shift(0).month}`;
const M2 = `${shift(1).year}-${shift(1).month}`;
const HORIZON = `${shift(0).year + 1}-${shift(0).month}-17`;

const CUT_LINE = "Arréglala y vuelve a leer: las líneas de abajo no se pudieron leer.";
const HEAD = ["pulsar · plantilla 1", "", "# Correr 10K", `horizonte: ${HORIZON}`, "medida: distancia · km"];
const BROKEN_HEAD = [...HEAD.slice(0, 4), "medida: distancia"];

const MONTH_BAD = `- ${M2} · 8 h`;
const MONTH_OK = `- ${M2} · 8 km`;
const SERIES_BAD = "- Series · martes · 30 min";
const SERIES_OK = "- Series · martes · 5 km";
const TASK_BAD = `- ${M1} · 2 h · Comprar zapatillas`;
const TASK_OK = `- ${M1} · Comprar zapatillas`;
const FONDO_OK = "- Fondo · sábado · 8 km";
const FONDO_BAD = "- Fondo · sábado · 8 h";

function plan(o: { head?: string[]; month?: string; fondo?: string; series?: string; task?: string } = {}) {
  return [
    ...(o.head ?? HEAD),
    "",
    "## Meses",
    `- ${M1} · 40 km`,
    o.month ?? MONTH_BAD,
    "",
    "## Compromisos",
    o.fondo ?? FONDO_OK,
    o.series ?? SERIES_BAD,
    "",
    "## Tareas",
    o.task ?? TASK_BAD,
    `- ${M2} · Inscribirme a la carrera`,
  ].join("\n");
}
const FIXED = plan({ month: MONTH_OK, series: SERIES_OK, task: TASK_OK });
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

async function open(page: Page) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await pageSettled(page);
}

async function paste(page: Page, text: string) {
  await open(page);
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
}

const alertOf = (page: Page) => appAlerts(page).filter({ hasText: /\S/ });
const rowsOf = (alert: Locator) => alert.getByRole("button");
const boxOf = (page: Page) => page.getByLabel(messages.textLabel);
const count = (n: number) => `${n} líneas por corregir`;

async function rowTexts(page: Page) {
  return (await rowsOf(alertOf(page)).allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
}

// Requests to the route made from now on.
function watchRoute(page: Page) {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/importar/leer")) hits.push(r.method());
  });
  return hits;
}

async function readWithThree(page: Page, text = plan()) {
  await paste(page, text);
  await expect(alertOf(page).getByText(count(3), { exact: true })).toBeVisible();
  await expect(rowsOf(alertOf(page))).toHaveCount(3);
}

test.describe("the error list is always what the box has now (board ImportarErroresVivos)", () => {
  test("state 1: fixing line 13 drops its row, the count reads 2 and the other rows stay", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = plan();
      await readWithThree(page, text);
      await boxOf(page).fill(plan({ series: SERIES_OK }));
      const alert = alertOf(page);
      await expect(alert.getByText(count(2), { exact: true })).toBeVisible();
      await expect(rowsOf(alert)).toHaveCount(2);
      const whole = (await alert.textContent()) ?? "";
      expect(whole).toContain(`Línea ${lineOf(text, MONTH_BAD)}:`);
      expect(whole).toContain(`Línea ${lineOf(text, TASK_BAD)}:`);
      expect(whole).not.toContain(`Línea ${lineOf(text, SERIES_BAD)}:`);
    });
  });

  test("the re-reading makes no request to /importar/leer, not even for the keystrokes of a whole fix", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await readWithThree(page);
      const hits = watchRoute(page);
      await boxOf(page).fill(plan({ series: SERIES_OK }));
      await expect(alertOf(page).getByText(count(2), { exact: true })).toBeVisible();
      await boxOf(page).pressSequentially(" ");
      await boxOf(page).fill(FIXED);
      await expect(alertOf(page)).toHaveCount(0);
      expect(hits).toEqual([]);
    });
  });

  test("focus and caret stay in the box after each keystroke of a fix", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = plan();
      await readWithThree(page, text);
      const box = boxOf(page);
      const alert = alertOf(page);
      await rowsOf(alert).filter({ hasText: `Línea ${lineOf(text, SERIES_BAD)}:` }).click();
      await expect(box).toBeFocused();
      for (const ch of SERIES_OK) {
        await box.pressSequentially(ch);
        const seen = await page.evaluate(() => ({
          focused: document.activeElement?.tagName,
          inList: document.activeElement?.closest('[role="alert"]') !== null,
        }));
        expect(seen.focused).toBe("TEXTAREA");
        expect(seen.inList).toBe(false);
      }
      await expect(alert.getByText(count(2), { exact: true })).toBeVisible();
      await expect(box).toBeFocused();
      const caret = await box.evaluate((el: HTMLTextAreaElement) => ({
        value: el.value,
        at: el.selectionStart,
        end: el.selectionEnd,
      }));
      expect(caret.value).toBe(plan({ series: SERIES_OK }));
      const expectedAt = plan({ series: SERIES_OK }).indexOf(SERIES_OK) + SERIES_OK.length;
      expect(caret.at).toBe(expectedAt);
      expect(caret.end).toBe(expectedAt);
    });
  });

  test("each row quotes its line as the box holds it now", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = plan();
      await readWithThree(page, text);
      const other = `- ${M2} · 8 horas`;
      await boxOf(page).fill(plan({ month: other }));
      const alert = alertOf(page);
      const n = lineOf(text, MONTH_BAD);
      const row = rowsOf(alert).filter({ hasText: `Línea ${n}:` });
      await expect(row).toContainText(`«${other}»`);
      await expect(row).not.toContainText(`«${MONTH_BAD}»`);
      await expect(rowsOf(alert)).toHaveCount(3);
    });
  });

  test("state 2: fixing a broken header drops the cut notice and lists the rows below, in order", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = plan({ head: BROKEN_HEAD });
      await paste(page, text);
      const alert = alertOf(page);
      await expect(alert.getByText("1 línea por corregir", { exact: true })).toBeVisible();
      await expect(alert.getByText(CUT_LINE, { exact: true })).toBeVisible();

      await boxOf(page).fill(plan());
      await expect(alert.getByText(count(3), { exact: true })).toBeVisible();
      await expect(alert.getByText(CUT_LINE, { exact: true })).toHaveCount(0);
      const rows = await rowTexts(page);
      expect(rows).toHaveLength(3);
      const lines = [MONTH_BAD, SERIES_BAD, TASK_BAD].map((w) => lineOf(text, w));
      rows.forEach((row, i) => {
        expect(row.startsWith(`Línea ${lines[i]}:`), row).toBe(true);
      });
    });
  });

  test("a line that breaks after the reading gets its row, in its order", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = plan();
      await readWithThree(page, text);
      await boxOf(page).fill(plan({ series: SERIES_OK }));
      await expect(alertOf(page).getByText(count(2), { exact: true })).toBeVisible();

      await boxOf(page).fill(plan({ series: SERIES_OK, fondo: FONDO_BAD }));
      await expect(alertOf(page).getByText(count(3), { exact: true })).toBeVisible();
      const rows = await rowTexts(page);
      const fondo = lineOf(text, FONDO_OK);
      expect(rows.map((r) => Number(/^Línea (\d+):/.exec(r)?.[1]))).toEqual([
        lineOf(text, MONTH_BAD),
        fondo,
        lineOf(text, TASK_BAD),
      ]);
      expect(rows[1]).toContain(`«${FONDO_BAD}»`);
    });
  });

  test("state 3: with every line fixed the list goes, the box loses its invalid mark and «Leer el plan» leads to the review", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await readWithThree(page);
      const box = boxOf(page);
      await expect(box).toHaveAttribute("aria-invalid", "true");
      await box.fill(FIXED);
      await expect(alertOf(page)).toHaveCount(0);
      await expect(page.getByText("líneas por corregir")).toHaveCount(0);
      await expect(box).not.toHaveAttribute("aria-invalid", "true");
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
    });
  });

  test("a text that stops being a template loses the list and the mark", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      for (const next of ["Quiero correr más este año.", ""]) {
        await readWithThree(page);
        await boxOf(page).fill(next);
        await expect(alertOf(page)).toHaveCount(0);
        await expect(page.getByText("líneas por corregir")).toHaveCount(0);
        await expect(boxOf(page)).not.toHaveAttribute("aria-invalid", "true");
      }
    });
  });

  test("a re-reading clears the pressed mark, and a row tapped afterwards still selects its line", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = plan();
      await readWithThree(page, text);
      const alert = alertOf(page);
      const row = (written: string) => rowsOf(alert).filter({ hasText: `Línea ${lineOf(text, written)}:` });
      await row(MONTH_BAD).click();
      await expect(alert.locator('[aria-current="true"]')).toHaveCount(1);

      // Same three rows after the edit: an index kept from before would still point at one of them.
      await boxOf(page).fill(plan({ month: `- ${M2} · 8 horas` }));
      await expect(rowsOf(alert).filter({ hasText: "8 horas" })).toHaveCount(1);
      await expect(rowsOf(alert)).toHaveCount(3);
      await expect(alert.locator("[aria-current]")).toHaveCount(0);

      await row(TASK_BAD).click();
      await expect(alert.locator('[aria-current="true"]')).toHaveCount(1);
      await expect(row(TASK_BAD)).toHaveAttribute("aria-current", "true");
      const picked = await boxOf(page).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
      expect(picked).toBe(TASK_BAD);
    });
  });

  test("while a reading is pending the box is disabled and the list does not come back before the answer", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await readWithThree(page);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/importar/leer", async (route) => {
        await gate;
        await route.continue();
      });
      await page.getByRole("button", { name: "Leer el plan" }).click();
      const box = boxOf(page);
      await expect(box).toBeDisabled();
      await expect(rowsOf(alertOf(page))).toHaveCount(0);
      await expect(page.getByText("líneas por corregir")).toHaveCount(0);
      release();
      await expect(box).toBeEnabled();
      await expect(alertOf(page).getByText(count(3), { exact: true })).toBeVisible();
      await expect(rowsOf(alertOf(page))).toHaveCount(3);
    });
  });

  test("a refusal that is not a list of lines does not change while typing", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.route("**/importar/leer", (route) =>
        route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "import.errors.modelFailed" }) }),
      );
      await paste(page, "Quiero correr más este año.");
      const refusal = "No pudimos leer el plan. Tu texto sigue aquí.";
      const alert = appAlerts(page).filter({ hasText: refusal });
      await expect(alert).toBeVisible();
      for (const next of [plan(), FIXED, "Otro texto", ""]) {
        await boxOf(page).fill(next);
        await expect(alert).toHaveText(refusal);
        await expect(alertOf(page)).toHaveCount(1);
        await expect(rowsOf(alertOf(page))).toHaveCount(0);
        await expect(boxOf(page)).not.toHaveAttribute("aria-invalid", "true");
      }
    });
  });

  test("a list read from an uploaded file is the box's list: the file's text is in the box and typing re-reads it, with no request", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page);
      await boxOf(page).fill("Quiero correr más este año.");
      const fileText = plan();
      await page.getByLabel(messages.upload).setInputFiles({ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from(fileText) });
      const alert = alertOf(page);
      await expect(alert.getByText(count(3), { exact: true })).toBeVisible();
      await expect(boxOf(page)).toHaveValue(fileText);
      expect(await rowTexts(page)).toHaveLength(3);

      const hits = watchRoute(page);
      await boxOf(page).fill(plan({ series: SERIES_OK }));
      await expect(alert.getByText(count(2), { exact: true })).toBeVisible();
      await expect(rowsOf(alert)).toHaveCount(2);
      await boxOf(page).fill(FIXED);
      await expect(alertOf(page)).toHaveCount(0);
      expect(hits).toEqual([]);
    });
  });
});
