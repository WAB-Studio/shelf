import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { todayInZone } from "../lib/zone";
import { unfold } from "./importar-plan";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";
import { boxOf } from "./box";

// RP-72, board `ImportarTodosLosErrores`: one reading answers every line that cannot be read.

function shift(by: number) {
  const [year, month] = todayInZone().split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: String((index % 12) + 1).padStart(2, "0") };
}
const M1 = `${shift(0).year}-${shift(0).month}`;
const M2 = `${shift(1).year}-${shift(1).month}`;
const HORIZON = `${shift(0).year + 1}-${shift(0).month}-17`;

const MONTH_OK = `- ${M1} · 40 km`;
const MONTH_BAD = `- ${M2} · 8 h`;
const FONDO = "- Fondo · sábado · 8 km";
const SERIES_BAD = "- Series · martes · 30 min";
const SERIES_OK = "- Series · martes · 3 km";
const TASK_BAD = `- ${M1} · 2 h · Comprar zapatillas`;
const TASK_OK = `- ${M1} · Comprar zapatillas`;
const TASK_LAST = `- ${M2} · Inscribirme a la carrera`;

const plan = (...body: string[][]) =>
  ["pulsar · plantilla 1", "", "# Correr 10K", `horizonte: ${HORIZON}`, "medida: distancia · km", "", ...body.flat()].join("\n");
const sections = (month: string, series: string, task: string) => [
  ["## Meses", MONTH_OK, month, "", "## Compromisos", FONDO, series, "", "## Tareas", task, TASK_LAST],
];
const BOARD = plan(...sections(MONTH_BAD, SERIES_BAD, TASK_BAD));
const lineOf = (text: string, written: string) => text.split("\n").indexOf(written) + 1;

const sentence = (line: number, written: string, expected: string) =>
  messages.errors.templateLine.replace("{line}", String(line)).replace("{text}", written).replace("{expected}", expected);
const KM = (s: string) => s.replaceAll("{unit}", "km");

async function asPerson(
  { person, browser, baseURL }: { person: { sessionFile: string }; browser: Browser; baseURL: string | undefined },
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 900 } });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

async function paste(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await pageSettled(page);
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
}

const alertOf = (page: Page) => appAlerts(page).filter({ hasText: /\S/ });

test.describe("one reading lists every mistake (RP-72)", () => {
  test("rows 1 and 2: three broken lines are listed in the text's order under «3 líneas por corregir»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await paste(page, BOARD);
      const alert = alertOf(page);
      await expect(alert).toBeVisible();
      await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
      const heading = await alert.getByText("3 líneas por corregir", { exact: true }).evaluate((el) => Number(getComputedStyle(el).fontWeight));
      expect(heading).toBeGreaterThanOrEqual(600);
      expect(await alert.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);

      const rows = [
        sentence(lineOf(BOARD, MONTH_BAD), MONTH_BAD, KM(messages.errors.form.monthUnit)),
        sentence(lineOf(BOARD, SERIES_BAD), SERIES_BAD, "Esa unidad no es km. Escribe la cantidad en km, como «- nombre · cadencia · 8 km»."),
        // 992: a task in another unit than the goal's names the unit that goes; the sentence is the catalogue's, so the row is found by its opening.
        `Línea ${lineOf(BOARD, TASK_BAD)}: «${TASK_BAD}». Esa unidad no es km.`,
      ];
      const rule = (row: string) => alert.getByText(row, row.endsWith("km.") ? {} : { exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
      for (const row of rows) await expect(alert.getByText(row, row.endsWith("km.") ? {} : { exact: true })).toBeVisible();
      expect(await rule(rows[0])).toBe(0);
      expect(await rule(rows[1])).toBeGreaterThan(0);
      expect(await rule(rows[2])).toBeGreaterThan(0);
      const whole = (await alert.textContent()) ?? "";
      const places = rows.map((row) => whole.indexOf(row));
      expect(places.every((p) => p >= 0)).toBe(true);
      expect([...places].sort((a, b) => a - b)).toEqual(places);
      expect(whole.indexOf("3 líneas por corregir")).toBeLessThan(places[0]);
      expect(whole).not.toContain(FONDO);
      expect(whole).not.toContain(TASK_LAST);

      const alertBox = (await boxOf(alert));
      const show = (await boxOf(page.getByText(messages.template.show, { exact: true })));
      const read = (await boxOf(page.getByRole("button", { name: "Leer el plan" })));
      expect(show.y).toBeGreaterThan(alertBox.y + alertBox.height - 1);
      expect(read.y).toBeGreaterThan(alertBox.y + alertBox.height - 1);
      await expect(page).toHaveURL(/\/metas\/importar$/);
    });
  });

  test("row 2: one broken line says «1 línea por corregir», singular", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await paste(page, plan(...sections(`- ${M2} · 8 km`, SERIES_OK, TASK_OK)).replace(MONTH_OK, `- ${M1} · 40 h`));
      const alert = alertOf(page);
      await expect(alert.getByText("1 línea por corregir", { exact: true })).toBeVisible();
      await expect(alert.getByText("líneas por corregir")).toHaveCount(0);
    });
  });

  test("row 3: a km commitment «8 km» is accepted and the review shows it with 8 km", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await paste(page, plan(...sections(`- ${M2} · 8 km`, SERIES_OK, TASK_OK)));
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      await expect(page.getByRole("button", { name: /^Sus partes/ }).first()).toBeVisible();
      await unfold(page);
      await expect(page.getByRole("checkbox", { name: /^Fondo .*8 km$/ })).toBeVisible();
    });
  });

  test("row 4: a km commitment written «30 min» answers with the sentence that names km", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await paste(page, plan(...sections(`- ${M2} · 8 km`, SERIES_BAD, TASK_OK)));
      const expected = sentence(lineOf(plan(...sections(`- ${M2} · 8 km`, SERIES_BAD, TASK_OK)), SERIES_BAD), SERIES_BAD, "Esa unidad no es km. Escribe la cantidad en km, como «- nombre · cadencia · 8 km».");
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
      await expect(alertOf(page).getByText("1 línea por corregir", { exact: true })).toBeVisible();
    });
  });

  test("row 5: in a goal measured in time, a month or a commitment in km names the goal's unit, not the generic form", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      const text = ["pulsar · plantilla 1", "# Estudiar", `horizonte: ${HORIZON}`, "medida: horas de estudio · minutos", "## Meses", `- ${M1} · 8 km`, "## Compromisos", "- Lectura · cada día · 8 km"].join("\n");
      await paste(page, text);
      const alert = alertOf(page);
      await expect(alert.getByText("2 líneas por corregir", { exact: true })).toBeVisible();
      const whole = (await alert.textContent()) ?? "";
      expect(whole).not.toContain(messages.errors.form.month);
      expect(whole).not.toContain(messages.errors.form.commitment);
      expect(whole.match(/Esa unidad no es de tiempo\./g)).toHaveLength(2);
      expect(whole).toContain(`Línea 6: «- ${M1} · 8 km»`);
      expect(whole).toContain("Línea 8: «- Lectura · cada día · 8 km»");
    });
  });

  test("row 6: a plan with no mistakes reaches the review", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await paste(page, messages.template.example.replace("2027-10-01", HORIZON).replace("2026-10-01 a 2026-12-31", `${M1}-01 a ${M1}-28`).replace(/2026-1[01]/g, (month) => (month === "2026-10" ? M1 : M2)));
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
    });
  });

  test("row 6: a missing «# nombre» is still reported, on its line", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await paste(page, `pulsar · plantilla 1\nhorizonte: ${HORIZON}\n`);
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toContainText(`Línea 2: «horizonte: ${HORIZON}». ${messages.errors.form.goal}`);
    });
  });
  test("992 K6: four lines of four kinds come back under «4 líneas por corregir», each with what fails", async ({ person, browser, baseURL }) => {
    // Kills: stopping at the first «ritmo:» of the head, or a row that falls back to the generic form.
    await asPerson({ person, browser, baseURL }, async (page) => {
      const lines = [
        "pulsar · plantilla 2",
        "",
        "# Aprender",
        `horizonte: ${HORIZON}`,
        "medida: Práctica · horas",
        "",
        "## Compromisos",
        "- Hablar · cada dia · 30 min",
        "- Leer · 8 veces por semana · toque",
        "",
        "# Escribir",
        `horizonte: ${HORIZON}`,
        "medida: Práctica · horas",
        "ritmo: 10",
        "",
        "## Tareas",
        `- ${M1} · 3 páginas · Algo`,
      ];
      await paste(page, lines.join("\n"));
      const alert = alertOf(page);
      await expect(alert).toBeVisible();
      await expect(alert.getByText("4 líneas por corregir", { exact: true })).toBeVisible();
      const rows = [
        [8, lines[7], "Falta la tilde: «cada día»."],
        [9, lines[8], "Una semana tiene 7 días: hasta «7 veces por semana»."],
        [14, lines[13], "Esta meta mide en horas: escribe el ritmo con su unidad, como «ritmo: 10 h»."],
        [17, lines[16], "Esa unidad no es de tiempo."],
      ] as const;
      const whole = (await alert.textContent()) ?? "";
      let from = -1;
      for (const [line, written, said] of rows) {
        const row = `Línea ${line}: «${written}». ${said}`;
        await expect(alert.getByText(row)).toBeVisible();
        const place = whole.indexOf(row);
        expect(place).toBeGreaterThan(from);
        from = place;
      }
      expect(whole).not.toContain(messages.errors.form.commitment);
      expect(whole).not.toContain(messages.errors.form.rhythmAmount);
      expect(whole).not.toContain(messages.errors.form.task);
      await expect(alert.getByText(messages.errors.templateCut)).toHaveCount(0);
      await expect(page).toHaveURL(/\/metas\/importar$/);
    });
  });
});
