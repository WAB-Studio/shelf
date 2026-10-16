import type { Locator, Page } from "@playwright/test";

import { GOAL_NOTE_MAX } from "@/lib/validation/plan";

import { test, expect } from "./fixtures";
import { countActionPosts, expectTitle, holdActions, MINUTES, monthsAhead, openAs, seedGoal } from "./meta-arbol-seed";
import { grouped, noOverflow, noteOf, setNote } from "./mover-nota-ayuda";
import { boxOf } from "./box";

// Module 872 (b) (RP-95), board `JerarquiaNota` and DESIGN.md: a goal's note sits between the end line
// and «Archivar esta meta», folded as «Nota»; with none, «Añadir una nota» stands in its place. The
// sheet is the task note's with other words: placeholder «Lo que quieras recordar de esta meta», the
// cap `GOAL_NOTE_MAX`, the count from nine tenths of it. Emptying and saving removes the note.

const MAX = GOAL_NOTE_MAX;
const COUNT_FROM = Math.round(MAX * 0.9);
const THREE = "línea uno\nlínea dos\nlínea tres";

async function seedOne(db: Parameters<typeof seedGoal>[0], person: Parameters<typeof seedGoal>[1], note?: string) {
  const name = `Meta con nota ${Date.now()}`;
  const id = await seedGoal(db, person, { name, unit: MINUTES, horizon: monthsAhead(4) });
  if (note !== undefined) await setNote(db, id, note);
  return { id, name };
}

async function openSheet(page: Page, opener: string): Promise<Locator> {
  await page.getByRole("button", { name: opener, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

const field = (sheet: Locator) => sheet.getByLabel("nota", { exact: true });

test("with no note the screen offers «Añadir una nota» between the end line and «Archivar esta meta», and no block (RP-95)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: drawing an empty «Nota» block for a goal with none; the note's place anywhere but between those two.
  const { id, name } = await seedOne(db, person);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    await expectTitle(page, name);
    const add = page.getByRole("button", { name: "Añadir una nota", exact: true });
    await expect(add).toBeVisible();
    await expect(page.getByRole("button", { name: "Nota", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cambiar la nota" })).toHaveCount(0);

    const y = async (locator: Locator) => (await boxOf(locator)).y;
    const end = await y(page.getByRole("button", { name: "mover el final" }));
    const archive = await y(page.getByRole("button", { name: "Archivar esta meta" }));
    const mine = await y(add);
    expect(end).toBeLessThan(mine);
    expect(mine).toBeLessThan(archive);
    expect((await boxOf(add)).width).toBeGreaterThan(300);
  } finally {
    await context.close();
  }
});

test("the empty sheet carries the goal's name and its own placeholder, with no «quitar la nota» (RP-95)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: the task note's placeholder or title; offering to remove a note that does not exist.
  const { id, name } = await seedOne(db, person);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "Añadir una nota");
    await expect(sheet.getByRole("heading", { name })).toBeVisible();
    await expect(field(sheet)).toHaveAttribute("placeholder", "Lo que quieras recordar de esta meta");
    await expect(field(sheet)).toHaveValue("");
    await expect(sheet.getByRole("button", { name: "quitar la nota" })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Guardar" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancelar" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a note of three lines saves to that goal alone, reads folded, and unfolds with its line breaks (RP-95)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: collapsing the line breaks; writing the note on another goal; showing the text while folded.
  const { id } = await seedOne(db, person);
  const other = await seedGoal(db, person, { name: `Otra ${Date.now()}`, unit: MINUTES, horizon: monthsAhead(4) });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "Añadir una nota");
    await field(sheet).fill(THREE);
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, id)).toBe(THREE);
    expect(await noteOf(db, other)).toBeNull();

    await page.reload();
    await expect(page.getByRole("button", { name: "Nota", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Añadir una nota" })).toHaveCount(0);
    await expect(page.getByText("línea uno")).toHaveCount(0);

    await page.getByRole("button", { name: "Nota", exact: true }).click();
    await expect(page.getByText("línea tres")).toBeVisible();
    const text = await page.locator("main").first().innerText();
    expect(text).toMatch(/línea uno\s*\n\s*línea dos\s*\n\s*línea tres/);
    await expect(page.getByRole("button", { name: "Cambiar la nota" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("«Cambiar la nota» opens on the note held, replaces it, and «quitar la nota» removes it for good (RP-95)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: opening the sheet empty; saving an old value; «quitar» that stores an empty string.
  const { id, name } = await seedOne(db, person, "Primera versión");
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: "Nota", exact: true }).click();
    const sheet = await openSheet(page, "Cambiar la nota");
    await expect(sheet.getByRole("heading", { name })).toBeVisible();
    await expect(field(sheet)).toHaveValue("Primera versión");
    await field(sheet).fill("Segunda versión");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, id)).toBe("Segunda versión");

    await page.reload();
    await page.getByRole("button", { name: "Nota", exact: true }).click();
    await expect(page.getByText("Segunda versión")).toBeVisible();
    const again = await openSheet(page, "Cambiar la nota");
    await again.getByRole("button", { name: "quitar la nota" }).click();
    await expect(again).toBeHidden();
    expect(await noteOf(db, id)).toBeNull();
    await page.reload();
    await expect(page.getByRole("button", { name: "Añadir una nota", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Nota", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("emptying the field and saving removes the note: null, never an empty string (RP-95)", async ({ person, browser, baseURL, db }) => {
  // Kills: storing "" (or the spaces) instead of removing the note.
  const { id } = await seedOne(db, person, "Para vaciar");
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: "Nota", exact: true }).click();
    const sheet = await openSheet(page, "Cambiar la nota");
    await field(sheet).fill("");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, id)).toBeNull();
    await page.reload();
    await expect(page.getByRole("button", { name: "Añadir una nota", exact: true })).toBeVisible();

    await setNote(db, id, "Otra vez");
    await page.reload();
    await page.getByRole("button", { name: "Nota", exact: true }).click();
    const blank = await openSheet(page, "Cambiar la nota");
    await field(blank).fill("  \n   ");
    await blank.getByRole("button", { name: "Guardar" }).click();
    await expect(blank).toBeHidden();
    expect(await noteOf(db, id)).toBeNull();
  } finally {
    await context.close();
  }
});

test("a note of exactly the cap saves; one more shows the refusal and the count in ink, keeps the text and sends nothing (RP-95)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: no limit in the client; a cap off by one; a limit written as a literal that drifts from `GOAL_NOTE_MAX`.
  const { id } = await seedOne(db, person);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openSheet(page, "Añadir una nota");
    const long = "a".repeat(MAX + 1);
    await field(sheet).fill(long);
    await expect(sheet.getByRole("alert")).toHaveText(`Es muy larga. Escribe máximo ${grouped(MAX)} caracteres.`);
    await expect(sheet.getByText(`${grouped(MAX + 1)} de ${grouped(MAX)}`)).toBeVisible();
    await expect(field(sheet)).toHaveValue(long);
    await expect(sheet.getByRole("button", { name: "Guardar" })).toBeDisabled();
    expect(calls.length).toBe(0);
    expect(await noteOf(db, id)).toBeNull();

    const exact = "b".repeat(MAX);
    await field(sheet).fill(exact);
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, id)).toBe(exact);
  } finally {
    await context.close();
  }
});

test("the count shows from nine tenths of the cap and not before (RP-95)", async ({ person, browser, baseURL, db }) => {
  // Kills: a count always on, or one that never appears.
  const { id } = await seedOne(db, person);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "Añadir una nota");
    await field(sheet).fill("c".repeat(COUNT_FROM - 1));
    await expect(sheet.getByText(new RegExp(` de ${grouped(MAX)}$`))).toHaveCount(0);
    await field(sheet).fill("c".repeat(COUNT_FROM));
    await expect(sheet.getByText(`${grouped(COUNT_FROM)} de ${grouped(MAX)}`)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("saving sends one request and locks the sheet; closing without saving sends none and keeps the old text (RP-95)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: a double send; saving on close; a sheet that keeps what was typed after «Cancelar».
  const { id } = await seedOne(db, person, "Texto anterior");
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`, 360, true);
  try {
    const calls = countActionPosts(page);
    await page.getByRole("button", { name: "Nota", exact: true }).click();
    const sheet = await openSheet(page, "Cambiar la nota");
    await field(sheet).fill("Escrito y descartado");
    await sheet.getByRole("button", { name: "Cancelar" }).click();
    await expect(sheet).toBeHidden();
    await page.clock.runFor(30_000);
    expect(calls.length).toBe(0);
    expect(await noteOf(db, id)).toBe("Texto anterior");
    const reopened = await openSheet(page, "Cambiar la nota");
    await expect(field(reopened)).toHaveValue("Texto anterior");

    await holdActions(page);
    await field(reopened).fill("Texto nuevo");
    const save = reopened.getByRole("button", { name: /Guardar|Guardando/ });
    await save.click();
    await expect.poll(() => calls.length).toBe(1);
    await expect(save).toBeDisabled();
    await expect(reopened.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await save.dispatchEvent("click");
    await expect(reopened).toBeHidden();
    expect(calls.length).toBe(1);
    expect(await noteOf(db, id)).toBe("Texto nuevo");
  } finally {
    await context.close();
  }
});

test("a failed save says so, keeps the text, and the retry saves (RP-95)", async ({ person, browser, baseURL, db }) => {
  // Kills: clearing the text or closing the sheet when the request fails.
  const { id } = await seedOne(db, person);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "Añadir una nota");
    await field(sheet).fill("texto que no se pierde");
    let refuse = true;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (refuse && request.method() === "POST" && request.headers()["next-action"]) await route.abort();
      else await route.continue();
    });
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet.getByRole("alert")).toHaveText("No se pudo guardar. Tu texto sigue aquí; inténtalo otra vez.");
    await expect(field(sheet)).toHaveValue("texto que no se pierde");
    expect(await noteOf(db, id)).toBeNull();

    refuse = false;
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, id)).toBe("texto que no se pierde");
  } finally {
    await context.close();
  }
});

test("at 360 px a long unbroken note and its open sheet do not overflow (RNP-07)", async ({ person, browser, baseURL, db }) => {
  // Kills: a note body or sheet that does not wrap.
  const { id } = await seedOne(db, person, `${"x".repeat(300)}\n${"palabra ".repeat(200)}`);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    await noOverflow(page);
    await page.getByRole("button", { name: "Nota", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cambiar la nota" })).toBeVisible();
    await noOverflow(page);
    const sheet = await openSheet(page, "Cambiar la nota");
    await noOverflow(page);
    const box = (await boxOf(sheet));
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
  }
});
