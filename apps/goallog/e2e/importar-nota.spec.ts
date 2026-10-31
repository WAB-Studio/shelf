import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { movedExample, unfold } from "./importar-plan";
import { boxOf } from "./box";

// The review draws a template task's and sub-task's note, whole and read-only
// (RP-45); the template path needs no model key. Board `ImportarRevisarNota`.

const TUTOR_NOTE = ["Preguntar por la tarifa por hora.", "Pedir una clase de prueba antes de pagar."];
const CHILD_NOTE = "Comparar tres perfiles.";

const template = () => movedExample().split("\n\n# Leer\n")[0];

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };
async function asPerson({ person, browser, baseURL }: Fixtures, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

async function toOpenReview(page: Page) {
  await page.goto("/metas/importar");
  await page.getByLabel(messages.textLabel).fill(template());
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await unfold(page);
}

test.describe("the review shows each task's note (RP-45)", () => {
  test("both notes sit whole under their tasks, read-only; unmarking a task hides no other; confirming stores them", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page);

      // A note stays shut behind the button that names it; its row is the box around its checkbox.
      const rowOf = (name: RegExp) => page.locator("div").filter({ has: page.getByRole("checkbox", { name }) }).last();
      const tutor = rowOf(/^Tutor/);
      await expect(page.getByText("Preguntar por la tarifa")).toHaveCount(0);
      await tutor.getByRole("button", { name: "nota · 2 líneas" }).click();
      const tutorNote = tutor.getByText("Preguntar por la tarifa", { exact: false });
      await expect(tutorNote).toBeVisible();
      await expect(tutorNote).toHaveText(TUTOR_NOTE.join("\n"));
      await expect(tutorNote).toHaveCSS("white-space", /pre-line/);
      await expect(tutorNote).toHaveCSS("font-size", "14px");
      // Whole: two lines of text, not clipped to one.
      expect((await boxOf(tutorNote)).height).toBeGreaterThan(2 * 13);

      await page.getByRole("button", { name: "2 sub-tareas" }).click();
      await rowOf(/^Elegir tutor/).getByRole("button", { name: "nota · 1 línea" }).click();
      const childNote = page.getByText(CHILD_NOTE, { exact: true });
      await expect(childNote).toBeVisible();
      // Read-only: no field holds a note.
      await expect(page.getByRole("textbox", { name: /nota/i })).toHaveCount(0);

      await page.getByRole("checkbox", { name: /Sesiones 1–4/ }).uncheck();
      await expect(tutorNote).toBeVisible();
      await expect(childNote).toBeVisible();

      await page.getByRole("button", { name: "Crear 3 metas" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      await expect(page.getByRole("link", { name: /IA aplicada/ }).first()).toBeVisible();

      const rows = await db`
        select name, note from goals.one_offs
        where user_id = ${person.id} and name in ('Tutor', 'Elegir tutor', 'Leer AI Engineering cap. 1–4') order by name`;
      expect(rows.map((r) => [r.name, r.note])).toEqual([
        ["Elegir tutor", CHILD_NOTE],
        ["Leer AI Engineering cap. 1–4", null],
        ["Tutor", TUTOR_NOTE.join("\n")],
      ]);
    });
  });
});
