import roadmap from "../messages/es/roadmap.json";
import { test, expect } from "./fixtures";
import { holdActions, monthsAhead } from "./meta-arbol-seed";
import {
  MINUTES,
  PAGES,
  dialog,
  firstMonthShare,
  mainLower,
  openedOnDay,
  postCounter,
  rhythmOfGoal,
  seedOpenGoal,
  seedTask,
  visit,
} from "./sin-final-seed";

// A locator that never appears fails in 6 s with its own name, never as the test's 30 s timeout.
test.use({ actionTimeout: 6000 });

// Module 916, RP-101: a goal measured in pages carries a rhythm — «40 páginas al mes» — which every
// month without its own amount takes; it has no «El plan». Boards: MetaRitmoUnidad, PorMesRitmoUnidad
// (private/tableros-sin-final/NOTAS.md §6–7). The refusal of a rhythm out of range in a unit other than
// time is `roadmap.errors.rhythmRangeAny`. Every test names the mutation that kills it.

const RANGE = roadmap.errors.rhythmRangeAny;
const SAVE = "Guardar el ritmo";

async function openRhythmSheet(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Poner un ritmo/ }).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Cuántas páginas al mes?" })).toBeVisible();
  return sheet;
}

for (const width of [360, 1280]) {
  test.describe(`at ${width}`, () => {
    test("a goal in pages with no rhythm offers «Poner un ritmo» under «El ritmo», and draws no «El plan» (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: `measuresOther` still hiding the rhythm row; drawing «El plan» for a unit other than time.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5), created: openedOnDay(5).at });
      await seedTask(db, person, id, "Terminar un libro", false);
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        await expect(page.getByText(/^el ritmo$/i)).toBeVisible();
        const row = page.getByRole("button", { name: /Poner un ritmo/ });
        await expect(row).toBeVisible();
        await expect(row).toContainText("cuántas páginas al mes; cada mes sin monto lo toma");
        await expect(page.getByText(/^el plan$/i)).toHaveCount(0);
        await expect(page.getByRole("button", { name: SAVE })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("the rhythm sheet says its question in pages, keeps the closed months, and offers save and cancel (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: reusing the hours sheet («¿Cuántas horas al mes?») for any unit.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        const sheet = await openRhythmSheet(page);
        await expect(sheet.getByLabel("páginas al mes")).toBeVisible();
        await expect(sheet.getByText("Los meses que ya cerraron no cambian.", { exact: true })).toBeVisible();
        await expect(sheet.getByRole("button", { name: SAVE, exact: true })).toBeVisible();
        await expect(sheet.getByRole("button", { name: "Cancelar", exact: true })).toBeVisible();
        expect(await sheet.innerText()).not.toMatch(/terminas el/i);
      } finally {
        await context.close();
      }
    });

    test("saving pends as «Guardando…» with both buttons disabled, then the row reads «40 páginas al mes» and the rhythm is stored (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: a save button with no `pending`; not revalidating after the write.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        const sheet = await openRhythmSheet(page);
        await sheet.getByLabel("páginas al mes").fill("40");
        await holdActions(page, 1500);
        await sheet.getByRole("button", { name: SAVE, exact: true }).click();
        await expect(sheet.getByRole("button", { name: "Guardando…", exact: true })).toBeDisabled();
        await expect(sheet.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
        await expect(dialog(page)).toHaveCount(0);
        expect(await rhythmOfGoal(db, id)).toBe(40);
        await expect(page.getByRole("button", { name: /40 páginas al mes/ })).toContainText("cada mes sin monto propio lo toma");
      } finally {
        await context.close();
      }
    });

    for (const [typed, label] of [["0", "zero"], ["1000001", "one past the cap"]] as const) {
      test(`a rhythm of ${label} is refused under the field with the range, and nothing is stored (RP-101)`, async ({ person, browser, baseURL, db }) => {
        // Kills: a field with no `invalid`; a range check missing either end; the hours sentence for pages.
        const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5) });
        const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
        try {
          const sheet = await openRhythmSheet(page);
          const field = sheet.getByLabel("páginas al mes");
          await field.fill(typed);
          await sheet.getByRole("button", { name: SAVE, exact: true }).click();
          await expect(sheet.getByText(RANGE, { exact: true })).toBeVisible();
          await expect(field).toHaveAttribute("aria-invalid", "true");
          await expect(sheet).toBeVisible();
          expect(await rhythmOfGoal(db, id)).toBeNull();
        } finally {
          await context.close();
        }
      });
    }

    test("a rhythm of 1 000 000 pages is the top the sheet takes (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: an upper bound one short of the CHECK the database holds.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        const sheet = await openRhythmSheet(page);
        await sheet.getByLabel("páginas al mes").fill("1000000");
        await sheet.getByRole("button", { name: SAVE, exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        expect(await rhythmOfGoal(db, id)).toBe(1_000_000);
      } finally {
        await context.close();
      }
    });

    test("«Cancelar» closes the sheet, sends nothing and leaves no rhythm (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: «Cancelar» that saves what was typed.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        const posts = postCounter(page);
        const sheet = await openRhythmSheet(page);
        await sheet.getByLabel("páginas al mes").fill("40");
        await sheet.getByRole("button", { name: "Cancelar", exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        expect(posts).toEqual([]);
        expect(await rhythmOfGoal(db, id)).toBeNull();
        await expect(page.getByRole("button", { name: /Poner un ritmo/ })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("a goal in pages is not planned: `/plan` sends it back to its screen, and its screen names no end it would reach (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: dropping the redirect; drawing «A este ritmo terminas el …» for a unit other than time.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, rhythm: 40, created: openedOnDay(5).at });
      await seedTask(db, person, id, "Terminar un libro", false);
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}/plan`, width);
      try {
        await expect(page).toHaveURL(new RegExp(`/metas/${id}$`));
        const text = await mainLower(page);
        expect(text).not.toMatch(/terminas el/);
        expect(text).not.toMatch(/termina el \d/);
        expect(text).toContain("40 páginas al mes");
      } finally {
        await context.close();
      }
    });

    test("a goal in time keeps «El plan» and its rhythm line (control)", async ({ person, browser, baseURL, db }) => {
      // Control: RP-101 leaves the plan to goals measured in time.
      const id = await seedOpenGoal(db, person, { name: "Estudiar", unit: MINUTES, horizon: monthsAhead(5), rhythm: 480 });
      await seedTask(db, person, id, "Un capítulo", true);
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        await expect(page.getByText(/^el plan$/i)).toBeVisible();
        expect(await mainLower(page)).toContain("ritmo 8 h al mes");
      } finally {
        await context.close();
      }
    });

    test("«Por mes» reads the rhythm in every month without an amount, the first month by its share, and no «sin monto» (RP-76, RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: `monthRows` that ignores the rhythm for a unit other than time.
      const opened = openedOnDay(5);
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, rhythm: 40, created: opened.at });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}/meses`, width);
      try {
        const next = page.locator(`main a[href="/metas/${id}/meses/${monthsAhead(1).slice(0, 7)}"]`).first();
        await expect(next).toContainText("40 páginas");
        expect((await next.innerText()).toLowerCase()).not.toContain("sin monto");
        const later = page.locator(`main a[href="/metas/${id}/meses/${monthsAhead(4).slice(0, 7)}"]`).first();
        await expect(later).toContainText("40 páginas");
        const current = page.locator(`main a[href="/metas/${id}/meses/${monthsAhead(0).slice(0, 7)}"]`).first();
        await expect(current).toContainText(`${firstMonthShare(40, opened.day)} páginas`);
        expect((await current.innerText()).toLowerCase()).not.toContain("sin monto");
      } finally {
        await context.close();
      }
    });

    test("a month without its own amount names the rhythm it takes; «Planear» still offers an amount of its own (RP-101)", async ({ person, browser, baseURL, db }) => {
      // Kills: `plannedOf` / the month detail reading no rhythm for a unit other than time.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: monthsAhead(5), rhythm: 40, created: openedOnDay(5).at });
      const month = monthsAhead(1);
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}/meses/${month.slice(0, 7)}`, width);
      try {
        const text = await mainLower(page);
        expect(text).toContain("40 páginas");
        expect(text).toContain("el ritmo: 40 páginas al mes");
        expect(text).not.toContain("sin monto");
        await expect(page.getByRole("link", { name: /^Planear / }).first()).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("the goal's own month says how much of the rhythm its opening day leaves, when it opened mid-month (RP-76)", async ({ person, browser, baseURL, db }) => {
      // Kills: a first month planned whole, or the share read from nothing.
      const opened = openedOnDay(5);
      test.skip(opened.day === 1, "opened on the 1st: the first month is whole");
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, rhythm: 40, created: opened.at });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        const share = firstMonthShare(40, opened.day);
        expect(await mainLower(page)).toMatch(new RegExp(`desde el ${opened.day} \\w+: ${share} de tus 40 páginas`));
      } finally {
        await context.close();
      }
    });
  });
}
