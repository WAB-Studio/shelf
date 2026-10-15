import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import tree from "../messages/es/tree.json";
import { test, expect } from "./fixtures";
import { holdActions, monthsAhead } from "./meta-arbol-seed";
import { rowMonths } from "./mes-siguiente-seed";
import { destination, openMoveSheet } from "./mover-nota-ayuda";
import { monthStartOf } from "./sin-final-seed";
import {
  MINUTES,
  PAGES,
  between,
  dialog,
  endLine,
  horizonOfGoal,
  mainLower,
  postCounter,
  seedOpenGoal,
  seedTask,
  visit,
} from "./metas-sin-final-seed";

// A locator that never appears fails in 6 s with its own name, never as the test's 30 s timeout.
test.use({ actionTimeout: 6000 });

// Module 916, RP-99: a goal with no end. Created without one, listed open and never ended, drawn
// without anything read from its end, given an end and relieved of it from its sheet, and listed
// «Por mes» through the twelve months that come. Boards: MetasSinFinal, MetaNuevaSinFinal,
// MetaSinFinal, FinalQuitarPoner, PorMesSinFinal (private/tableros-sin-final/NOTAS.md §1–5).
// Every test names the mutation that kills it.

const NO_END_SENTENCE = "No termina nunca. Se le puede dar un final después.";
const RANGE_SECTION = /semana \d+ de \d+/i;

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

for (const width of [360, 1280]) {
  test.describe(`at ${width}`, () => {
    // ---- /metas/nueva -------------------------------------------------------------------------

    test("«Sin final» opens the goal with no horizon, and its screen draws no end line (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: sending `horizonForWeeks` whatever the chip says; drawing «hasta el» for a null horizon.
      const { page, context } = await visit(browser, baseURL, person, "/metas/nueva", width);
      try {
        const name = `Cuidado ${Date.now()}`;
        await page.getByLabel("nombre", { exact: true }).fill(name);
        await page.getByRole("radio", { name: "sin final", exact: true }).click();
        await expect(page.getByText(NO_END_SENTENCE)).toBeVisible();
        await expect(page.getByLabel(/^semanas/)).toHaveCount(0);
        await page.getByRole("button", { name: "Abrirla", exact: true }).click();
        await expect(page).toHaveURL(/\/metas\/[0-9a-f-]{36}$/);
        const [row] = await db<{ horizon: string | null }[]>`
          select horizon::text as horizon from goals.goals where user_id = ${person.id} and name = ${name}`;
        expect(row.horizon).toBeNull();
        await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
        await expect(page.getByRole("button", { name: "ponerle final" })).toBeVisible();
        expect(await mainLower(page)).not.toMatch(/hasta el \d/);
      } finally {
        await context.close();
      }
    });

    test("«Con final» still opens the goal with the end its weeks name (control)", async ({ person, browser, baseURL, db }) => {
      // Control: guards the 12-weeks path against the change that adds the other chip.
      const { page, context } = await visit(browser, baseURL, person, "/metas/nueva", width);
      try {
        const name = `Con final ${Date.now()}`;
        await page.getByLabel("nombre", { exact: true }).fill(name);
        await page.getByLabel(/^semanas|final/i).first().fill("12");
        await page.getByRole("button", { name: "Abrirla", exact: true }).click();
        await expect(page).toHaveURL(/\/metas\/[0-9a-f-]{36}$/);
        const [row] = await db<{ horizon: string | null }[]>`
          select horizon::text as horizon from goals.goals where user_id = ${person.id} and name = ${name}`;
        expect(row.horizon).not.toBeNull();
      } finally {
        await context.close();
      }
    });

    test("an empty name with «Sin final» chosen shows its sentence under the field and does not navigate (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: swallowing the refusal (the silent submit).
      const { page, context } = await visit(browser, baseURL, person, "/metas/nueva", width);
      try {
        const posts = postCounter(page);
        await page.getByRole("radio", { name: "sin final", exact: true }).click();
        await page.getByRole("button", { name: "Abrirla", exact: true }).click();
        await expect(page.getByText("Escribe un nombre.", { exact: true })).toBeVisible();
        await expect(page.getByLabel("nombre", { exact: true })).toHaveAttribute("aria-invalid", "true");
        await expect(page).toHaveURL(/\/metas\/nueva$/);
        const [{ n }] = await db<{ n: string }[]>`select count(*)::text as n from goals.goals where user_id = ${person.id}`;
        expect(Number(n)).toBe(0);
        expect(posts).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test("«Abrirla» pends as «Abriéndola…», disabled, then lands on the goal (RP-99)", async ({ person, browser, baseURL }) => {
      // Kills: a button with no pending state (a second tap opens a second goal).
      const { page, context } = await visit(browser, baseURL, person, "/metas/nueva", width);
      try {
        await holdActions(page, 1500);
        await page.getByLabel("nombre", { exact: true }).fill(`Pendiente ${Date.now()}`);
        await page.getByRole("radio", { name: "sin final", exact: true }).click();
        await page.getByRole("button", { name: "Abrirla", exact: true }).click();
        const pending = page.getByRole("button", { name: "Abriéndola…", exact: true });
        await expect(pending).toBeVisible();
        await expect(pending).toBeDisabled();
        await expect(page).toHaveURL(/\/metas\/[0-9a-f-]{36}$/);
      } finally {
        await context.close();
      }
    });

    // ---- /metas ---------------------------------------------------------------------------------

    test("an endless goal is open, says «sin final» where «hasta el» would be, and is never among «Terminadas» (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: `lastDay(goal)` / the open-or-ended cut on a null horizon.
      const endless = `Cuidado personal ${Date.now()}`;
      const ended = `Examen de manejo ${Date.now()}`;
      await seedOpenGoal(db, person, { name: endless, unit: MINUTES, horizon: null });
      await seedOpenGoal(db, person, { name: ended, horizon: plusDays(-10), created: new Date(Date.now() - 90 * 86_400_000) });
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await expect(page.getByText(ended, { exact: true }).first()).toBeVisible();
        const text = await mainLower(page);
        const open = between(text, "abiertas", "terminadas");
        const closed = between(text, "terminadas");
        expect(open).toContain(endless.toLowerCase());
        expect(open).toContain("sin final");
        expect(open).not.toMatch(/hasta el/);
        expect(closed).not.toContain(endless.toLowerCase());
        expect(closed).not.toContain("sin final");
        expect(closed).toContain(ended.toLowerCase());
      } finally {
        await context.close();
      }
    });

    test("a goal with no end that holds goals says «sin final · 2 metas»; its goal with an end keeps its date (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: dropping the count from the no-end line; drawing «hasta el» for the holder.
      const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: null });
      await seedOpenGoal(db, person, { name: "Correr 10 km", parent: salud, unit: MINUTES, horizon: monthsAhead(2) });
      await seedOpenGoal(db, person, { name: "Dormir mejor", parent: salud, unit: MINUTES, horizon: null });
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await expect(page.getByText("sin final · 2 metas", { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    // ---- the goal's screen ----------------------------------------------------------------------

    test("an endless goal's screen draws «sin final» and «ponerle final», no «semana N de M», no «terminó», no «mover el final» (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: `horizonWeeks` / `dayBefore(goal.horizon)` computed with no condition.
      const id = await seedOpenGoal(db, person, { name: "Cuidado personal", unit: MINUTES, horizon: null, rhythm: 480 });
      await seedTask(db, person, id, "Pedir cita", true);
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        await expect(page.getByRole("heading", { level: 1, name: "Cuidado personal" })).toBeVisible();
        await expect(page.getByRole("button", { name: "ponerle final" })).toBeVisible();
        await expect(page.getByRole("button", { name: "mover el final" })).toHaveCount(0);
        const text = await mainLower(page);
        expect(text).toContain("sin final");
        expect(text).not.toMatch(RANGE_SECTION);
        expect(text).not.toContain("terminó");
        expect(text).not.toMatch(/hasta el \d/);
        // RP-101: «El plan» stays for time, and says no date for an end that is not there.
        expect(text).not.toMatch(/a este ritmo terminas/);
        expect(text).not.toMatch(/termina el \d/);
        expect(text).toContain("ritmo 8 h al mes");
      } finally {
        await context.close();
      }
    });

    test("a goal with an end still draws its weeks line, its date and «mover el final» (control)", async ({ person, browser, baseURL, db }) => {
      // Control: the new branch must not take the old line away.
      const id = await seedOpenGoal(db, person, { name: "Con final", unit: MINUTES, horizon: monthsAhead(3) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        await expect(page.getByText(/semanas? · hasta el \d+ \w+ \d{4}/)).toBeVisible();
        await expect(page.getByRole("button", { name: "mover el final" })).toBeVisible();
        await expect(page.getByRole("button", { name: "ponerle final" })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    // ---- the end's sheet ------------------------------------------------------------------------

    test("«Quitar el final» is offered for a goal with an end, pends with both buttons disabled, and leaves it endless (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: a button with no `pending`; not revalidating after the write (the line stays).
      const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: MINUTES, horizon: monthsAhead(3) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        await page.getByRole("button", { name: "mover el final" }).click();
        const sheet = dialog(page);
        await expect(sheet.getByRole("heading", { name: "¿Cuántas semanas?" })).toBeVisible();
        await expect(sheet.getByRole("button", { name: "Moverlo", exact: true })).toBeVisible();
        await holdActions(page, 1500);
        const remove = sheet.getByRole("button", { name: "Quitar el final", exact: true });
        await remove.click();
        await expect(sheet.getByRole("button", { name: "Quitar el final", exact: true })).toBeDisabled();
        await expect(sheet.getByRole("button", { name: "Dejarlo como está", exact: true })).toBeDisabled();
        await expect(dialog(page)).toHaveCount(0);
        expect(await horizonOfGoal(db, id)).toBeNull();
        await expect(page.getByRole("button", { name: "ponerle final" })).toBeVisible();
        await expect(page.getByRole("button", { name: "mover el final" })).toHaveCount(0);
        expect(await mainLower(page)).not.toMatch(/hasta el \d/);
      } finally {
        await context.close();
      }
    });

    test("«Dejarlo como está» closes the sheet, sends nothing and the end stays (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: closing the sheet after writing; «Dejarlo como está» wired to «Quitar el final».
      const horizon = monthsAhead(3);
      const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: MINUTES, horizon });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        const posts = postCounter(page);
        await page.getByRole("button", { name: "mover el final" }).click();
        const sheet = dialog(page);
        await sheet.getByLabel(/^semanas, contando/).fill("3");
        await sheet.getByRole("button", { name: "Dejarlo como está", exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        expect(posts).toEqual([]);
        expect(await horizonOfGoal(db, id)).toBe(horizon);
      } finally {
        await context.close();
      }
    });

    test("an endless goal's sheet offers «Ponerle final» and «Dejarla sin final», never «Quitar el final»; putting an end brings the line and a notice back (RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: offering «Quitar el final» to an endless goal; not revalidating after the write.
      const name = "Leer";
      const id = await seedOpenGoal(db, person, { name, unit: PAGES, horizon: null });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, width);
      try {
        await page.getByRole("button", { name: "ponerle final" }).click();
        const sheet = dialog(page);
        await expect(sheet.getByRole("heading", { name: "¿Cuántas semanas?" })).toBeVisible();
        await expect(sheet.getByRole("button", { name: "Quitar el final", exact: true })).toHaveCount(0);
        await expect(sheet.getByRole("button", { name: "Dejarla sin final", exact: true })).toBeVisible();
        await sheet.getByLabel("semanas, contando esta", { exact: true }).fill("12");
        const hint = (await sheet.getByText(/^termina el /).innerText()).replace(/^termina el /, "").replace(/ · .*$/, "").trim();
        expect(hint).toMatch(/^\d{1,2} \w{3} \d{4}$/);
        await holdActions(page, 1200);
        await sheet.getByRole("button", { name: "Ponerle final", exact: true }).click();
        await expect(sheet.getByRole("button", { name: "Ponerle final", exact: true })).toBeDisabled();
        await expect(dialog(page)).toHaveCount(0);
        expect(await horizonOfGoal(db, id)).not.toBeNull();
        await expect(page.getByText(new RegExp(`semanas? · hasta el ${hint}`))).toBeVisible();
        await expect(page.getByRole("button", { name: "mover el final" })).toBeVisible();
        await expect(page.getByText(`${name} termina el ${hint}.`, { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("putting an end on a goal that holds an endless one is refused naming it, and nothing is written (RP-99, P2)", async ({ person, browser, baseURL, db }) => {
      // Kills: a generic error in place of the `belowNoEnd` sentence with the goal's name.
      const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: null });
      await seedOpenGoal(db, person, { name: "Dormir mejor", parent: salud, unit: MINUTES, horizon: null });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${salud}`, width);
      try {
        await page.getByRole("button", { name: "ponerle final" }).click();
        const sheet = dialog(page);
        await sheet.getByLabel("semanas, contando esta", { exact: true }).fill("20");
        // Board 4: the refusal reads under the field as the weeks are typed, and «Ponerle final» stays unfilled.
        await expect(sheet.getByRole("button", { name: "Ponerle final", exact: true })).toBeDisabled();
        await expect(sheet.getByText(tree.errors.belowNoEnd.replace("{name}", "Dormir mejor"), { exact: true })).toBeVisible();
        await expect(sheet.getByLabel("semanas, contando esta", { exact: true })).toHaveAttribute("aria-invalid", "true");
        await expect(dialog(page)).toBeVisible();
        expect(await horizonOfGoal(db, salud)).toBeNull();
      } finally {
        await context.close();
      }
    });

    test("removing the end of a goal inside one that has an end is refused with the goal above and its date (RP-79, RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: letting the endless goal sit under a goal with an end; omitting the reason.
      const aboveHorizon = monthsAhead(6);
      const above = await seedOpenGoal(db, person, { name: "Product Designer junior", unit: MINUTES, horizon: aboveHorizon });
      const inside = await seedOpenGoal(db, person, { name: "Portafolio", parent: above, unit: MINUTES, horizon: monthsAhead(3) });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${inside}`, width);
      try {
        await page.getByRole("button", { name: "mover el final" }).click();
        await dialog(page).getByRole("button", { name: "Quitar el final", exact: true }).click();
        const sentence = tree.errors.endPastAbove.replace("{name}", "Product Designer junior").replace("{date}", endLine(aboveHorizon));
        await expect(dialog(page).getByText(sentence, { exact: true })).toBeVisible();
        expect(await horizonOfGoal(db, inside)).toBe(monthsAhead(3));
      } finally {
        await context.close();
      }
    });

    test("moving an endless goal under one with an end offers that goal dimmed with the reason (RP-79, RP-99)", async ({ person, browser, baseURL, db }) => {
      // Kills: omitting the destination's refusal for a goal with an end above an endless one.
      const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: null });
      const dormir = await seedOpenGoal(db, person, { name: "Dormir mejor", parent: salud, unit: MINUTES, horizon: null });
      const pdHorizon = monthsAhead(8);
      await seedOpenGoal(db, person, { name: "Product Designer junior", unit: MINUTES, horizon: pdHorizon });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${dormir}`, width);
      try {
        const sheet = await openMoveSheet(page);
        await expect(destination(sheet, "Product Designer junior")).toBeDisabled();
        await expect(
          sheet.getByText(tree.errors.endPastAbove.replace("{name}", "Product Designer junior").replace("{date}", endLine(pdHorizon)), { exact: true }),
        ).toBeVisible();
        await expect(destination(sheet, "Salud")).toBeChecked();
        await expect(sheet.getByRole("button", { name: "Moverla", exact: true })).toBeDisabled();
      } finally {
        await context.close();
      }
    });

    // ---- «Por mes» ------------------------------------------------------------------------------

    test("«Por mes» of an endless goal opened 2 months ago lists its 3 months and next month, folds the rest ahead into a line and has no «ver todo» (RP-99, RP-107, RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: an empty list for a null horizon; the months ahead drawn as rows; «Sin final: se ven los 12…» left in; «ver todo» with nothing hidden.
      const created = new Date(`${monthStartOf(-2).slice(0, 8)}05T12:00:00Z`);
      const id = await seedOpenGoal(db, person, { name: "Cuidado personal", unit: MINUTES, horizon: null, rhythm: 480, created });
      const { page, context } = await visit(browser, baseURL, person, `/metas/${id}/meses`, width);
      try {
        await expect(page.getByText("Sin final: se ven los 12 meses que vienen.", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: /los demás meses que vienen: 8 h cada uno/i })).toBeVisible();
        // Next month's row leads to its sheet, the others to the page; every row names its month and year.
        const rows = await rowMonths(page, id);
        expect(rows).toEqual([-2, -1, 0, 1].map((n) => monthStartOf(n).slice(0, 7)).sort());
        expect(await mainLower(page)).toContain("4 meses");
        await expect(page.getByRole("link", { name: "ver todo", exact: true })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}
