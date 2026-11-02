import ExcelJS from "exceljs";
import { createTranslator } from "next-intl";
import type postgres from "postgres";

import messages from "../messages/es/import.json";
import { templateWorkbook } from "../lib/import/workbook";
import { test, expect } from "./fixtures";
import { asPerson, countOf } from "./importar-plan";

// A workbook uploaded on /metas/importar (RP-98): read on the server with no key, no claim and no
// model. The boards are `ImportarExcelFilas` and `ImportarExcelAjeno`.

const say = (key: string) =>
  (createTranslator({ locale: "es", messages: { import: messages }, namespace: "import" }) as unknown as (k: string) => string)(key);

const GOAL = "Evals y harness";

async function load(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await templateWorkbook(say)) as never);
  return wb;
}

const bytes = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

const upload = (name: string, buffer: Buffer) => ({
  name,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer,
});

async function modelCalls(db: postgres.Sql, id: string) {
  return (await db`select 1 from goals.model_calls where user_id = ${id}`).length;
}

test.describe("a workbook is read on the server, never by the model (RP-98)", () => {
  test("broken rows are all said at once, in sheet and row order, with their count, and the text box stays empty", async ({ person, browser, baseURL, db }) => {
    // Kills: showing only the first broken row, or leaving the generic failure.
    const wb = await load();
    // Meses row 4: a month that does not exist. Tareas row 6: an amount in words. Compromisos row 5: a cadence in words.
    wb.getWorksheet("Meses")!.addRow([GOAL, "2026-13", "37 h"]);
    wb.getWorksheet("Tareas")!.addRow([GOAL, "2026-10", "Semana 3", null, "tres horas", null]);
    wb.getWorksheet("Compromisos")!.addRow([GOAL, "Inglés", "de lunes a viernes y domingo", "1 h"]);
    const file = upload("plantilla-goallog.xlsx", await bytes(wb));

    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByLabel(messages.upload).setInputFiles(file);
      await page.getByRole("button", { name: messages.read }).click();

      await expect(page.getByText("3 filas por corregir", { exact: true })).toBeVisible();
      const alert = page.getByRole("alert").filter({ hasText: "3 filas por corregir" });
      const rows = alert.getByText(/^(Meses|Tareas|Compromisos), fila \d+: /);
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveText(`Meses, fila 4: ${messages.errors.form.monthReal}`);
      await expect(rows.nth(1)).toHaveText(/^Compromisos, fila 5: /);
      await expect(rows.nth(2)).toHaveText(/^Tareas, fila 6: /);
      await expect(page.getByText("Leído de plantilla-goallog.xlsx. Corrige el libro y vuelve a subirlo.", { exact: true })).toBeVisible();
      await expect(page.getByLabel(messages.textLabel, { exact: true })).toHaveValue("");
      await expect(alert.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("link", { name: messages.entry.workbook })).toBeVisible();
      await expect(page).toHaveURL(/\/metas\/importar$/);
    });
    expect(await modelCalls(db, person.id)).toBe(0);
  });

  test("a book with a broken header says that one row and nothing below it", async ({ person, browser, baseURL, db }) => {
    // Kills: judging the rows under a header that is already wrong.
    const wb = await load();
    wb.getWorksheet("Meses")!.getRow(1).getCell(2).value = "Cuando";
    wb.getWorksheet("Meses")!.addRow([GOAL, "2026-13", "37 h"]);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByLabel(messages.upload).setInputFiles(upload("plantilla-goallog.xlsx", await bytes(wb)));
      await page.getByRole("button", { name: messages.read }).click();
      await expect(page.getByText("1 fila por corregir", { exact: true })).toBeVisible();
      await expect(page.getByText(/^Meses, fila 1: /)).toBeVisible();
      await expect(page.getByText(/^Meses, fila 4: /)).toHaveCount(0);
    });
    expect(await modelCalls(db, person.id)).toBe(0);
  });

  test("another book says to use the template, offers the download and costs no read", async ({ person, browser, baseURL, db }) => {
    // Kills: leaving the generic failure, or sending the book on to the model.
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Gastos");
    sheet.addRow(["Fecha", "Concepto", "Monto"]);
    sheet.addRow(["2026-10-02", "Mercado", 52000]);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByLabel(messages.upload).setInputFiles(upload("gastos-octubre.xlsx", await bytes(wb)));
      await page.getByRole("button", { name: messages.read }).click();

      await expect(page.getByText(messages.errors.workbookNotTemplate, { exact: true })).toBeVisible();
      await expect(page.getByText("Leído de gastos-octubre.xlsx.", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: messages.entry.workbook })).toBeVisible();
      await expect(page.getByText(messages.errors.modelFailed)).toHaveCount(0);
      await expect(page.getByText(messages.errors.noKey)).toHaveCount(0);
      await expect(page.getByLabel(messages.textLabel, { exact: true })).toHaveValue("");
    });
    expect(await modelCalls(db, person.id)).toBe(0);
  });

  test("the template book itself goes to the review, counted in rows, with no read spent", async ({ person, browser, baseURL, db }) => {
    // Kills: sending a good book to the model, or counting its rows as lines.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByLabel(messages.upload).setInputFiles(upload("plantilla-goallog.xlsx", await bytes(await load())));
      await page.getByRole("button", { name: messages.read }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
      const count = await countOf(page, "filas");
      expect(count.plan + count.notes + count.out).toBe(count.total);
      expect(count.out).toBe(0);
    });
    expect(await modelCalls(db, person.id)).toBe(0);
  });
});
