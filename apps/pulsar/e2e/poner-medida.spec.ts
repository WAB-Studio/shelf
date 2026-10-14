import type { Browser, Locator, Page } from "@playwright/test";

import { test, expect, visit, type Person } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import type { Db } from "./meta-arbol-seed";
import { PAGES, dialog, horizonOfGoal, postCounter, seedOpenGoal } from "./metas-sin-final-seed";

// Module 964, RP-117 (board PonerMedida, approved 2026-10-14): a goal that measures nothing offers «Ponerle medida»
// under «esta meta no mide nada»; the sheet «¿Qué mide?» takes what it counts and its unit, says what is missing before
// anything leaves the device, says the server's refusal under the field it touches, and once saved the goal reads
// «mide en cajas» and offers the rhythm. Every test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const DAY_MS = 86_400_000;
const NAME_LABEL = "qué cuenta";
const UNIT_LABEL = "en qué unidad";
const DAY_BACK = (days: number) => new Date(Date.now() - days * DAY_MS);

async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width = 360) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

const offer = (page: Page) => page.getByRole("button", { name: "Ponerle medida", exact: true });
const nameField = (sheet: Locator) => sheet.getByLabel(NAME_LABEL, { exact: true });
const unitField = (sheet: Locator) => sheet.getByLabel(UNIT_LABEL, { exact: true });
const save = (sheet: Locator) => sheet.getByRole("button", { name: "Guardar", exact: true });
const cancel = (sheet: Locator) => sheet.getByRole("button", { name: "Cancelar", exact: true });

async function openSheet(page: Page) {
  await offer(page).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Qué mide?" })).toBeVisible();
  return sheet;
}

async function measureOf(db: Db, id: string) {
  const [row] = await db<{ name: string | null; unit: string | null }[]>`
    select measure_name as name, measure_unit as unit from goals.goals where id = ${id}`;
  return row;
}

const mudanza = (db: Db, person: Person) => seedOpenGoal(db, person, { name: "Mudanza", unit: null, created: DAY_BACK(3) });

test("«Mudanza» offers «Ponerle medida» under «esta meta no mide nada»; a goal that measures, one that holds goals, an archived one and an ended one do not (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: drawing the button always (or dropping any of the four guards: unit, children, archived, ended).
  const bare = await mudanza(db, person);
  const measured = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, created: DAY_BACK(3) });
  const holder = await seedOpenGoal(db, person, { name: "Casa", unit: null, created: DAY_BACK(3) });
  await seedOpenGoal(db, person, { name: "Cocina", parent: holder, unit: null, created: DAY_BACK(3) });
  const archived = await seedOpenGoal(db, person, { name: "Vieja", unit: null, created: DAY_BACK(30) });
  await db`update goals.goals set archived_at = now() where id = ${archived}`;
  const ended = await seedOpenGoal(db, person, { name: "Terminada", unit: null, horizon: new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10), created: DAY_BACK(60) });

  const a = await open(browser, baseURL, person.sessionFile, `/metas/${bare}`);
  try {
    await expect(offer(a.page)).toBeVisible();
    const says = a.page.getByText("esta meta no mide nada", { exact: true });
    await expect(says).toBeVisible();
    // Below the sentence, as the board draws it.
    const [textBox, buttonBox] = [await says.boundingBox(), await offer(a.page).boundingBox()];
    expect(buttonBox!.y).toBeGreaterThan(textBox!.y);
  } finally {
    await a.context.close();
  }
  for (const [label, id] of [["measured", measured], ["holder", holder], ["archived", archived], ["ended", ended]] as const) {
    const b = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
    try {
      await expect(b.page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(offer(b.page), label).toHaveCount(0);
    } finally {
      await b.context.close();
    }
  }
});

test("the empty sheet draws its title, its two fields and its two buttons (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: a missing field or a renamed button (the sheet drawn from another primitive's words).
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page);
    await expect(nameField(sheet)).toHaveValue("");
    await expect(unitField(sheet)).toHaveValue("");
    await expect(save(sheet)).toBeEnabled();
    await expect(cancel(sheet)).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("«Guardar» with «qué cuenta» empty says «Escribe qué cuenta.» under it and writes nothing, sending nothing (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: no client validation (the call leaves, the row may take a blank name or the server's own wording shows).
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page);
    await unitField(sheet).fill("cajas");
    await save(sheet).click();
    await expect(sheet.getByText("Escribe qué cuenta.", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Escribe qué se cuenta.", { exact: true })).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    expect(posts).toEqual([]);
    expect(await measureOf(db, id)).toEqual({ name: null, unit: null });
    // A name of spaces is as empty as none.
    await nameField(sheet).fill("   ");
    await save(sheet).click();
    await expect(sheet.getByText("Escribe qué cuenta.", { exact: true })).toBeVisible();
    expect(posts).toEqual([]);
  } finally {
    await context.close();
  }
});

test("«Guardar» with «en qué unidad» empty says «Escribe qué se cuenta.» and writes nothing, sending nothing (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: validating only the name; a unit of spaces accepted.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page);
    await nameField(sheet).fill("Cajas embaladas");
    await unitField(sheet).fill("  ");
    await save(sheet).click();
    await expect(sheet.getByText("Escribe qué se cuenta.", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Escribe qué cuenta.", { exact: true })).toHaveCount(0);
    expect(posts).toEqual([]);
    expect(await measureOf(db, id)).toEqual({ name: null, unit: null });
  } finally {
    await context.close();
  }
});

test("a refused name goes away once corrected and saved; pending, both buttons are disabled and a second tap sends nothing more (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: leaving «Guardar» / «Cancelar» enabled while the action is in flight (a double write).
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page);
    await unitField(sheet).fill("cajas");
    await save(sheet).click();
    await expect(sheet.getByText("Escribe qué cuenta.", { exact: true })).toBeVisible();
    await nameField(sheet).fill("Cajas embaladas");
    await holdActions(page, 1500);
    await save(sheet).click();
    await expect(save(sheet)).toBeDisabled();
    await expect(cancel(sheet)).toBeDisabled();
    await save(sheet).dispatchEvent("click");
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(await measureOf(db, id)).toEqual({ name: "Cajas embaladas", unit: "cajas" });
  } finally {
    await context.close();
  }
});

test("another screen gave the goal its measure first: «Esta meta ya mide en páginas.» under the unit, the sheet stays, the row is the other's (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: swallowing the server's `error` (the sheet closes or stays mute) or overwriting the measure.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page);
    await nameField(sheet).fill("Cajas embaladas");
    await unitField(sheet).fill("cajas");
    await db`update goals.goals set measure_name = 'Páginas leídas', measure_unit = 'páginas' where id = ${id}`;
    await save(sheet).click();
    await expect(sheet.getByText("Esta meta ya mide en páginas.", { exact: true })).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    await expect(save(sheet)).toBeEnabled();
    expect(await measureOf(db, id)).toEqual({ name: "Páginas leídas", unit: "páginas" });
  } finally {
    await context.close();
  }
});

test("«Cancelar» with both fields full closes the sheet and writes nothing, sending nothing (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: saving on dismiss.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page);
    await nameField(sheet).fill("Cajas embaladas");
    await unitField(sheet).fill("cajas");
    await cancel(sheet).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(posts).toEqual([]);
    expect(await measureOf(db, id)).toEqual({ name: null, unit: null });
    await expect(offer(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("saving «Cajas embaladas» / «cajas» closes the sheet and, without reloading, the goal says «mide Cajas embaladas, en cajas», offers the rhythm and no longer the measure (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: not refreshing after the save (the screen still says «esta meta no mide nada»); writing only the unit.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page);
    await nameField(sheet).fill("Cajas embaladas");
    await unitField(sheet).fill("cajas");
    await save(sheet).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("mide Cajas embaladas, en cajas", { exact: true })).toBeVisible();
    await expect(page.getByText("mide en cajas", { exact: true })).toHaveCount(0);
    await expect(page.getByText("esta meta no mide nada", { exact: true })).toHaveCount(0);
    await expect(offer(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Poner un ritmo/ })).toBeVisible();
    expect(await measureOf(db, id)).toEqual({ name: "Cajas embaladas", unit: "cajas" });
    expect(await horizonOfGoal(db, id)).not.toBeNull();
  } finally {
    await context.close();
  }
});

test("«horas» is stored in minutes and the goal reads «mide Horas de estudio, en horas y minutos» (RP-117, RP-66, RP-121)", async ({ person, browser, baseURL, db }) => {
  // Kills: storing the unit as typed (the goal would read «mide en horas»).
  const id = await seedOpenGoal(db, person, { name: "Estudio", unit: null, created: DAY_BACK(3) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page);
    await nameField(sheet).fill("Horas de estudio");
    await unitField(sheet).fill("horas");
    await save(sheet).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("mide Horas de estudio, en horas y minutos", { exact: true })).toBeVisible();
    expect((await measureOf(db, id)).unit).toBe("minutos");
  } finally {
    await context.close();
  }
});

test("at 360 the measure sheet, with its refusal showing, does not overflow the screen (RP-117)", async ({ person, browser, baseURL, db }) => {
  // Kills: a field, a hint or a button wider than the sheet (a class drawn outside `components/ui`).
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 360);
  try {
    const sheet = await openSheet(page);
    await unitField(sheet).fill("cajas");
    await save(sheet).click();
    await expect(sheet.getByText("Escribe qué cuenta.", { exact: true })).toBeVisible();
    const over = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
      const box = dlg.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sheet: dlg.scrollWidth - dlg.clientWidth,
        right: box.right - window.innerWidth,
        left: box.left,
      };
    });
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.sheet).toBeLessThanOrEqual(0);
    expect(over.right).toBeLessThanOrEqual(0);
    expect(over.left).toBeGreaterThanOrEqual(0);
  } finally {
    await context.close();
  }
});
