import type { Page } from "@playwright/test";

import { civilDateInZone, civilDayMonthYear } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import {
  between,
  dialog,
  habitRows,
  mainLower,
  postCounter,
  visit,
} from "./metas-sin-final-seed";
import { TODAY, monthLabel, monthStartOf, seedFact, seedHabit, shift } from "./sin-final-seed";

// Module 924, RP-104, RP-105, RP-106: the screen of a loose habit, `/metas/habitos/{habitId}`. Board:
// HabitoPantalla (private/tableros-s2/NOTAS.md §1). Written from the contract before `editHabit` (922) and
// `loadHabit` (923) exist. Dates are relative to the day the app reads. Every test names the mutation that
// kills it.

// A locator that never appears fails in 6 s with its own name, never as the test's 30 s timeout.
test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const daysIn = (offset: number) =>
  Math.round((noonOf(monthStartOf(offset + 1)).getTime() - noonOf(monthStartOf(offset)).getTime()) / 86_400_000);
const dayOfMonth = Number(TODAY.slice(8, 10));
const MONTH_RE = /(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}/g;

const habitPath = (id: string, query = "") => `/metas/habitos/${id}${query}`;

// The text of the months table: from «por mes» to the end of the screen's text.
async function monthsText(page: Page): Promise<string> {
  const text = await mainLower(page);
  return between(text, "por mes");
}

const rowsOf = (section: string) => section.match(MONTH_RE) ?? [];

// Seeded 30 days back, daily, tap: the plain habit most tests drive.
async function plain(db: import("./meta-arbol-seed").Db, personId: string, opts: { name?: string; note?: string } = {}) {
  const id = await seedHabit(db, personId, opts.name ?? "Meditar", { kind: "daily" }, { kind: "tap" }, { created: noonOf(shift(TODAY, -30)) });
  if (opts.note !== undefined) await db`update goals.commitments set note = ${opts.note} where id = ${id}`;
  return id;
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "Editarlo" })).toBeVisible();
  return sheet;
}

test.describe("reaching the screen (RP-105)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("/metas: tapping a habit's row opens its screen and never «¿Retirarlo?»", async ({ person, browser, baseURL, db }) => {
    // Kills: the row's onClick still opening RetireSheet; a row with no href.
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/metas", 360);
    try {
      await page.getByText("Meditar", { exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/habitos/${id}$`));
      await expect(page.getByRole("heading", { level: 1, name: "Meditar" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "¿Retirarlo?" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("/metas: a live habit's row is a link to its screen, drawn with a chevron", async ({ person, browser, baseURL, db }) => {
    // Kills: a row drawn as a button; a link without the chevron (Row without `href`).
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/metas", 360);
    try {
      await mainLower(page);
      const link = page.locator(`main a[href="${habitPath(id)}"]:visible`);
      await expect(link).toHaveCount(1);
      await expect(link).toContainText("Meditar");
      const chevron = await link.evaluate((a) => (a.textContent ?? "").includes("›") || a.querySelector("svg") !== null);
      expect(chevron).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("Mes: the habit's name is a link that opens its screen with ?volver=/mes, and back returns to /mes", async ({ person, browser, baseURL, db }) => {
    // Kills: a name drawn as plain text in Mes; a link without `volver`; a back link that ignores it.
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      await mainLower(page);
      await page.locator("main").getByRole("link", { name: "Meditar", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/habitos/${id}\\?`));
      expect(new URL(page.url()).searchParams.get("volver")).toBe("/mes");
      await expect(page.getByRole("heading", { level: 1, name: "Meditar" })).toBeVisible();
      await page.locator("main").getByRole("link", { name: /^Volver a Mes$/ }).click();
      await expect(page).toHaveURL(/\/mes$/);
    } finally {
      await context.close();
    }
  });

  test("?volver=https://x is not followed: back returns to /metas, as with no ?volver", async ({ person, browser, baseURL, db }) => {
    // Kills: using `volver` as given (an open redirect); defaulting to Mes.
    const id = await plain(db, person.id);
    for (const query of ["?volver=https://x", "?volver=//x.com", ""]) {
      const { page, context } = await visit(browser, baseURL, person, habitPath(id, query), 360);
      try {
        await mainLower(page);
        const back = page.locator("main").getByRole("link", { name: /^Volver a Metas$/ });
        await expect(back).toHaveAttribute("href", "/metas");
        await back.click();
        await expect(page).toHaveURL(/\/metas$/);
        expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
      } finally {
        await context.close();
      }
    }
  });
});

test.describe("the screen of a habit (RP-105, RP-106)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("full: created two months ago, 4 facts last month → three rows, last month «4 de N días», the current one «en curso»", async ({ person, browser, baseURL, db }) => {
    // Kills: months counted from the 1st instead of from the day it was created; a row per fact; the current month unmarked.
    const created = shift(monthStartOf(-2), 19);
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: noonOf(created) });
    for (let n = 0; n < 4; n += 1) await seedFact(db, person.id, id, null, shift(monthStartOf(-1), n));
    await db`update goals.commitments set note = 'Cinco minutos al levantarme.' where id = ${id}`;
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      const text = await mainLower(page);
      await expect(page).toHaveTitle(/Hábito/);
      expect(text).toContain(`hábito · desde el ${civilDayMonthYear(created)}`.toLowerCase());
      expect(text).toContain("todos los días");
      expect(text).toContain("cinco minutos al levantarme.");
      const section = between(text, "por mes");
      expect(rowsOf(section)).toEqual([monthLabel(-2), monthLabel(-1), monthLabel(0)]);
      expect(section).toMatch(new RegExp(`${monthLabel(-2)}\\D*0 de ${daysIn(-2) - 19} días`));
      expect(section).toMatch(new RegExp(`${monthLabel(-1)}\\D*4 de ${daysIn(-1)} días`));
      expect(section).toMatch(new RegExp(`${monthLabel(0)}[^\\d]*0 de ${dayOfMonth} días`));
      expect(section).toContain("en curso");
      expect(section.indexOf("en curso")).toBeGreaterThan(section.indexOf(monthLabel(-1)));
      expect(section).not.toContain("ver todo");
      await expect(page.getByRole("button", { name: "Editar", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("empty: created today → one row, «0 de 1 día» (the catalogue's singular)", async ({ person, browser, baseURL, db }) => {
    // Kills: a plural that ignores «1 día»; a first row before the creation month; the month counted whole.
    const id = await seedHabit(db, person.id, "Recién", { kind: "daily" }, { kind: "tap" }, { created: noonOf(TODAY) });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      const section = await monthsText(page);
      expect(rowsOf(section)).toEqual([monthLabel(0)]);
      expect(section).toMatch(/0 de 1 día(?!s)/);
      expect(section).not.toContain("0 de 1 días");
    } finally {
      await context.close();
    }
  });

  test("weekly cadence counts weeks: «N de M semanas» on every closed month, never «N días»", async ({ person, browser, baseURL, db }) => {
    // Kills: «N días» left on a cadence that counts by the week; «1 de 1 semanas»; a figure on a month with no week closed.
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, {
      created: noonOf(monthStartOf(-1)),
    });
    for (let n = 0; n < 3; n += 1) await seedFact(db, person.id, id, null, shift(monthStartOf(-1), n));
    await seedFact(db, person.id, id, null, TODAY);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain("1 vez por semana");
      const section = between(text, "por mes");
      expect(rowsOf(section)).toEqual([monthLabel(-1), monthLabel(0)]);
      expect(section).toMatch(new RegExp(`${monthLabel(-1)}\\D*\\d+ de \\d+ semanas`));
      expect(section).not.toMatch(/\d+ días?/);
      expect(section).not.toContain("0 de 0");
    } finally {
      await context.close();
    }
  });

  test("more than 12 months: the last 12, the current one last, «ver todo» under them; it opens all 20", async ({ person, browser, baseURL, db }) => {
    // Kills: no cut; the cut taking the oldest 12; a «ver todo» that reloads the same 12; a stray «ver menos».
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: noonOf(monthStartOf(-19)) });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      const section = await monthsText(page);
      const expected = Array.from({ length: 12 }, (_, i) => monthLabel(i - 11));
      expect(rowsOf(section)).toEqual(expected);
      expect(section).not.toContain(monthLabel(-12));
      const more = page.getByRole("link", { name: "ver todo", exact: true });
      await expect(more).toHaveCount(1);
      // Under the table, on the left.
      const box = (await more.boundingBox())!;
      const last = (await page.getByText(monthLabel(0), { exact: false }).first().boundingBox())!;
      expect(box.y).toBeGreaterThan(last.y);
      expect(box.x).toBeLessThan(60);
      await more.click();
      await expect(page).toHaveURL(/todo=1/);
      await expect(page.getByText(monthLabel(-19), { exact: false }).first()).toBeVisible();
      const all = await monthsText(page);
      expect(rowsOf(all)).toEqual(Array.from({ length: 20 }, (_, i) => monthLabel(i - 19)));
      expect(all).not.toContain("ver todo");
      // Two «ver menos» (above and under the table) that return without `todo=1`.
      const less = page.getByRole("link", { name: /ver menos/i });
      await expect(less).toHaveCount(2);
      for (const link of await less.all()) expect(await link.getAttribute("href")).not.toContain("todo=1");
    } finally {
      await context.close();
    }
  });

  test("exactly 12 months: all 12 and no «ver todo»", async ({ person, browser, baseURL, db }) => {
    // Kills: a cut that offers «ver todo» at 12 rows (> 11 instead of > 12).
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: noonOf(monthStartOf(-11)) });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      const section = await monthsText(page);
      expect(rowsOf(section)).toHaveLength(12);
      expect(section).not.toContain("ver todo");
    } finally {
      await context.close();
    }
  });

  test("retired: «retirado el {fecha}» under the name, the months still read, neither «Editar» nor «Retirarlo»", async ({ person, browser, baseURL, db }) => {
    // Kills: the buttons drawn for a retired habit; a retired habit that 404s or loses its months.
    const created = shift(monthStartOf(-1), 2);
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, {
      created: noonOf(created),
      retired: noonOf(TODAY),
    });
    await seedFact(db, person.id, id, null, shift(monthStartOf(-1), 3));
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain(`retirado el ${civilDayMonthYear(TODAY)}`.toLowerCase());
      expect(rowsOf(between(text, "por mes"))).toEqual([monthLabel(-1), monthLabel(0)]);
      await expect(page.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("another person's habit, and one that does not exist, say the page does not exist and leak nothing", async ({ person, personId, browser, baseURL, db }) => {
    // Kills: a loader that does not scope to the person (a stranger's habit read through the service role); a throw instead of notFound.
    const stranger = await seedHabit(db, personId, "Secreto ajeno", { kind: "daily" });
    const own = await plain(db, person.id);
    try {
      // Control: the person's own habit does open, so a not-found below is the loader's answer, not a missing route.
      const mine = await visit(browser, baseURL, person, habitPath(own), 360);
      try {
        await expect(mine.page.getByRole("heading", { level: 1, name: "Meditar" })).toBeVisible();
      } finally {
        await mine.context.close();
      }
      for (const id of [stranger, "00000000-0000-4000-8000-000000000000", "xyz"]) {
        const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
        try {
          await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
          await expect(page.getByText("Secreto ajeno")).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toHaveCount(0);
        } finally {
          await context.close();
        }
      }
    } finally {
      await db`delete from goals.commitments where id = ${stranger} and user_id = ${personId}`;
    }
  });

  test("with no session the screen sends to /entrar", async ({ browser, baseURL }) => {
    // Kills: a page that reads before asking who is there.
    const context = await browser.newContext({ baseURL: baseURL!, storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      await page.goto(habitPath("00000000-0000-4000-8000-000000000000"));
      await expect(page).toHaveURL(/\/entrar/);
    } finally {
      await context.close();
    }
  });
});

test.describe("«Editar» (RP-104)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("the sheet comes prefilled; saving closes it and the screen, /metas and the database read the new name and note", async ({ person, browser, baseURL, db }) => {
    // Kills: an empty sheet; a name not written; a screen that keeps the old name; the note dropped.
    const id = await plain(db, person.id, { note: "Cinco minutos." });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      await expect(sheet.getByLabel("nombre", { exact: true })).toHaveValue("Meditar");
      await expect(sheet.getByLabel("nota, si quieres", { exact: true })).toHaveValue("Cinco minutos.");
      await sheet.getByLabel("nombre", { exact: true }).fill("Meditar al despertar");
      await sheet.getByLabel("nota, si quieres", { exact: true }).fill("Diez minutos, sin celular.");
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "Meditar al despertar" })).toBeVisible();
      expect(await mainLower(page)).toContain("diez minutos, sin celular.");
      const [row] = await db<{ name: string; note: string | null; cadence_kind: string }[]>`
        select name, note, cadence_kind from goals.commitments where id = ${id}`;
      expect(row).toEqual({ name: "Meditar al despertar", note: "Diez minutos, sin celular.", cadence_kind: "daily" });
      await page.goto("/metas");
      await expect(page.getByText("Meditar al despertar", { exact: true })).toBeVisible();
      await expect(page.getByText("Meditar", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("clearing the note stores null, never an empty string", async ({ person, browser, baseURL, db }) => {
    // Kills: storing '' for a cleared note (the schema's blank-to-null transform dropped).
    const id = await plain(db, person.id, { note: "Cinco minutos." });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      await sheet.getByLabel("nota, si quieres", { exact: true }).fill("");
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      const [row] = await db<{ note: string | null; name: string }[]>`select note, name from goals.commitments where id = ${id}`;
      expect(row.note).toBeNull();
      expect(row.name).toBe("Meditar");
      // The sheet closes before the refresh lands: wait for the screen, never read it once.
      await expect(page.locator("main")).not.toContainText("Cinco minutos.", { ignoreCase: true });
    } finally {
      await context.close();
    }
  });

  test("pending: «Guardando…», both buttons disabled, and a second tap sends nothing: one request, one write", async ({ person, browser, baseURL, db }) => {
    // Kills: a button that stays enabled while the action runs (two writes); a Cancelar that closes mid-save.
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      await holdActions(page, 1500);
      const posts = postCounter(page);
      await sheet.getByLabel("nombre", { exact: true }).fill("Meditar al despertar");
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      const pending = sheet.getByRole("button", { name: "Guardando…", exact: true });
      await expect(pending).toBeVisible();
      await expect(pending).toBeDisabled();
      await expect(sheet.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
      await pending.click({ force: true });
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toHaveCount(0);
      expect(posts).toHaveLength(1);
      expect((await habitRows(db, person, "Meditar al despertar"))).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("refused on the client: an empty name and a note over 2 000 characters name the problem under the field, the sheet stays, nothing is sent", async ({ person, browser, baseURL, db }) => {
    // Kills: no client validation (a request leaves); the sentence missing or drawn elsewhere; the sheet closing on refusal.
    const id = await plain(db, person.id, { note: "Cinco minutos." });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      const posts = postCounter(page);
      await sheet.getByLabel("nombre", { exact: true }).fill("");
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      await expect(sheet.getByText("Escribe un nombre.", { exact: true })).toBeVisible();
      await sheet.getByLabel("nombre", { exact: true }).fill("Meditar");
      await sheet.getByLabel("nota, si quieres", { exact: true }).fill("x".repeat(2001));
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      await expect(sheet.getByText("La nota pasa de 2 000 caracteres.", { exact: true })).toBeVisible();
      await expect(dialog(page)).toHaveCount(1);
      expect(posts).toEqual([]);
      const [row] = await db<{ name: string; note: string | null }[]>`select name, note from goals.commitments where id = ${id}`;
      expect(row).toEqual({ name: "Meditar", note: "Cinco minutos." });
    } finally {
      await context.close();
    }
  });

  test("refused on the server: retired in another tab, «Ese hábito ya está retirado.» shows in the sheet and nothing is written", async ({ person, browser, baseURL, db }) => {
    // Kills: an action that renames a retired habit; a refusal that closes the sheet or shows nothing.
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      await db`update goals.commitments set retired_at = now() where id = ${id}`;
      await sheet.getByLabel("nombre", { exact: true }).fill("Otro nombre");
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      await expect(sheet.getByText("Ese hábito ya está retirado.", { exact: true })).toBeVisible();
      await expect(dialog(page)).toHaveCount(1);
      const [row] = await db<{ name: string }[]>`select name from goals.commitments where id = ${id}`;
      expect(row.name).toBe("Meditar");
    } finally {
      await context.close();
    }
  });

  test("cancelled: «Cancelar» closes the sheet and writes nothing", async ({ person, browser, baseURL, db }) => {
    // Kills: a Cancelar that saves; a sheet that keeps the typed draft on screen.
    const id = await plain(db, person.id, { note: "Cinco minutos." });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      const posts = postCounter(page);
      await sheet.getByLabel("nombre", { exact: true }).fill("No lo guardes");
      await sheet.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "Meditar" })).toBeVisible();
      expect(posts).toEqual([]);
      const [row] = await db<{ name: string; note: string | null }[]>`select name, note from goals.commitments where id = ${id}`;
      expect(row).toEqual({ name: "Meditar", note: "Cinco minutos." });
    } finally {
      await context.close();
    }
  });

  test("the sheet has no cadence or quantity field: only the name and the note", async ({ person, browser, baseURL, db }) => {
    // Kills: a sheet that reuses the creation form (cadence and quantity editable, past months rewritten).
    const id = await seedHabit(db, person.id, "Leer", { kind: "daily" }, { kind: "quantity", target: 10, unit: "páginas" }, {
      created: noonOf(shift(TODAY, -30)),
    });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const sheet = await openSheet(page);
      await expect(sheet.getByRole("textbox")).toHaveCount(2);
      for (const role of ["spinbutton", "radio", "checkbox", "combobox", "switch", "slider"] as const) {
        await expect(sheet.getByRole(role)).toHaveCount(0);
      }
      const inside = (await sheet.innerText()).toLowerCase();
      for (const word of ["cadencia", "veces por semana", "cantidad", "páginas", "todos los días"]) expect(inside).not.toContain(word);
    } finally {
      await context.close();
    }
  });
});

test.describe("«Retirarlo» from the screen (RP-105)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("confirming sets retired_at, keeps the screen in its retired state, and /metas no longer lists it", async ({ person, browser, baseURL, db }) => {
    // Kills: a Retirarlo that deletes the row; a screen that leaves or keeps the buttons; a retired habit still listed.
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      await page.getByRole("button", { name: "Retirarlo", exact: true }).click();
      const sheet = dialog(page);
      await expect(sheet.getByRole("heading", { name: "¿Retirarlo?" })).toBeVisible();
      await sheet.getByRole("button", { name: "Retirarlo", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/metas/habitos/${id}$`));
      await expect(page.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toHaveCount(0);
      const rows = await habitRows(db, person, "Meditar");
      expect(rows).toHaveLength(1);
      expect(rows[0].retired_at).not.toBeNull();
      // The server stamps `retired_at` with SQL `now()`: the day it reads is the real one, not the pinned clock's.
      await expect(page.getByText(`retirado el ${civilDayMonthYear(civilDateInZone(new Date(rows[0].retired_at!)))}`, { exact: false })).toBeVisible();
      await page.goto("/metas");
      expect(await mainLower(page)).toContain("ninguno todavía.");
    } finally {
      await context.close();
    }
  });

  test("«Dejarlo como está» closes the sheet, writes nothing and the habit stays live", async ({ person, browser, baseURL, db }) => {
    // Kills: a cancel that retires.
    const id = await plain(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const posts = postCounter(page);
      await page.getByRole("button", { name: "Retirarlo", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Dejarlo como está", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(posts).toEqual([]);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toBeVisible();
      expect((await habitRows(db, person, "Meditar"))[0].retired_at).toBeNull();
    } finally {
      await context.close();
    }
  });
});

test.describe("at 360 (RP-105, RNP-07)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("nothing overflows the width: the screen with 20 months and a long name, and its sheet", async ({ person, browser, baseURL, db }) => {
    // Kills: a table or a long name wider than the phone; a sheet that spills past the edge.
    const id = await seedHabit(
      db,
      person.id,
      "Leer antes de dormir sin celular ni televisión en el cuarto",
      { kind: "daily" },
      { kind: "quantity", target: 10, unit: "páginas" },
      { created: noonOf(monthStartOf(-19)) },
    );
    await db`update goals.commitments set note = ${"Una nota larga ".repeat(30)} where id = ${id}`;
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
    try {
      await mainLower(page);
      await expect(page.getByRole("button", { name: "Editar", exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      const sheet = await openSheet(page);
      await page.evaluate(() => document.fonts.ready);
      const fit = await sheet.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { scroll: el.scrollWidth - el.clientWidth, left: rect.left, right: rect.right, page: document.documentElement.scrollWidth };
      });
      expect(fit.scroll).toBeLessThanOrEqual(0);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.right).toBeLessThanOrEqual(360);
      expect(fit.page).toBeLessThanOrEqual(360);
    } finally {
      await context.close();
    }
  });
});
