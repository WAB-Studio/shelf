import type { Locator } from "@playwright/test";

import { test, expect, visit } from "./fixtures";
import {
  archiveTogether,
  archivedOf,
  countActionPosts,
  expectTitle,
  flat,
  holdActions,
  MINUTES,
  openAs,
  seedDailyAsk,
  seedGoal,
  seedTree,
} from "./meta-arbol-seed";

// Module 872 (RP-83, RP-24), board `JerarquiaArchivar` and user decision P5: archiving a goal that
// holds goals says how many go with it, names them, and archives the whole branch; reopening it
// reopens the goals archived with it and none archived on their own before. A goal under an archived
// one is not reopened alone. Tree: General G > large g1 > small p, and a second large g2 under G.

async function openSheet(page: import("@playwright/test").Page): Promise<Locator> {
  await page.getByRole("button", { name: "Archivar esta meta" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("the sheet of a general with three goals says 3, names them and offers to archive them all (RP-83)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not passing the branch count to the sheet (today's sentence and buttons stay), or counting the goal itself (4).
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const sheet = await openSheet(page);
    await expect(sheet.getByRole("heading", { name: "¿Archivarla?" })).toBeVisible();
    const text = flat(await sheet.innerText());
    expect(text).toContain("Con ella se archivan 3 metas: ");
    for (const name of [tree.names.g1, tree.names.p, tree.names.g2]) expect(text).toContain(`«${name}»`);
    expect(text).not.toContain(`«${tree.names.G}»`);
    expect(text).toContain(". Sus hechos y compromisos siguen aquí; al reabrirla se abren las 3.");
    // The sentence of a goal with nothing under it is replaced, not added to.
    expect(text).not.toContain("Sale de Hoy y de Semana");
    await expect(sheet.getByRole("button", { name: "Archivarla con sus 3", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Dejarlas abiertas", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Archivarla", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the sheet of a large goal with one goal says it in the singular (RP-83)", async ({ person, browser, baseURL, db }) => {
  // Kills: a count that includes the goal itself or its ancestors, or a plural that ignores the number 1.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    const sheet = await openSheet(page);
    const text = flat(await sheet.innerText());
    expect(text).toContain(`Con ella se archivan 1 meta: «${tree.names.p}». `);
    expect(text).toContain("al reabrirla se abre.");
    await expect(sheet.getByRole("button", { name: "Archivarla con su meta", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("confirming archives the general and every goal under it, and Hoy shows none of them (RP-83, RP-24)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: archiving only the goal the screen is on (the three below stay open and stay in Hoy).
  const tree = await seedTree(db, person, Date.now());
  await seedDailyAsk(db, person, tree.p, `Pedido de la pequeña ${tree.p.slice(0, 6)}`);
  await seedDailyAsk(db, person, tree.g2, `Pedido de la grande ${tree.g2.slice(0, 6)}`);
  const { page, context } = await openAs(browser, baseURL, person, "/");
  try {
    await expect(page.getByText(`Pedido de la pequeña ${tree.p.slice(0, 6)}`)).toBeVisible();
    await expect(page.getByText(`Pedido de la grande ${tree.g2.slice(0, 6)}`)).toBeVisible();

    await visit(page, `/metas/${tree.G}`);
    const sheet = await openSheet(page);
    const confirm = sheet.getByRole("button", { name: "Archivarla con sus 3", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();

    const archived = await archivedOf(db, [tree.G, tree.g1, tree.p, tree.g2]);
    expect(archived).toEqual({ [tree.G]: true, [tree.g1]: true, [tree.p]: true, [tree.g2]: true });

    await visit(page, "/");
    await expect(page.getByText(`Pedido de la pequeña ${tree.p.slice(0, 6)}`)).toHaveCount(0);
    await expect(page.getByText(`Pedido de la grande ${tree.g2.slice(0, 6)}`)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("while archiving, the confirm cannot fire a second time (RP-83)", async ({ person, browser, baseURL, db }) => {
  // Kills: re-enabling «Archivarla con sus 3» before the answer arrives (a second tap sends a second request).
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const sheet = await openSheet(page);
    await holdActions(page);
    const calls = countActionPosts(page);
    const confirm = sheet.getByRole("button", { name: "Archivarla con sus 3", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect.poll(() => calls.length).toBe(1);
    await expect(confirm).toBeDisabled();
    await confirm.dispatchEvent("click");
    await confirm.dispatchEvent("click");

    await expect(sheet).toBeHidden();
    expect(calls).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("«Dejarlas abiertas» closes the sheet, sends nothing and archives nothing (RP-83)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: the cancel button archiving, or archiving on opening the sheet.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`, 360, true);
  try {
    const calls = countActionPosts(page);
    const sheet = await openSheet(page);
    await expect(sheet.getByText(/Con ella se archivan 3 metas/)).toBeVisible();
    await sheet.getByRole("button", { name: "Dejarlas abiertas", exact: true }).click();
    await expect(sheet).toBeHidden();
    await page.clock.runFor(30_000);
    expect(calls).toEqual([]);
    const archived = await archivedOf(db, [tree.G, tree.g1, tree.p, tree.g2]);
    expect(Object.values(archived).every((value) => value === false)).toBe(true);
  } finally {
    await context.close();
  }
});

test("a goal with nothing under it keeps today's sheet, with no count, whether it is alone or inside another (RP-83)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: showing «Con ella se archivan 0 metas» (or any count line) on a goal with nothing under it.
  const tree = await seedTree(db, person, Date.now());
  const lone = await seedGoal(db, person, { name: `Sola archivar ${Date.now()}`, unit: MINUTES });
  for (const id of [lone, tree.p]) {
    const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
    try {
      const sheet = await openSheet(page);
      const text = flat(await sheet.innerText());
      expect(text).toContain("Sus hechos, las semanas que gobernó y sus compromisos siguen aquí.");
      expect(text).not.toContain("Con ella se archivan");
      expect(text).not.toMatch(/\b0\b/);
      await expect(sheet.getByRole("button", { name: "Archivarla", exact: true })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Dejarla abierta", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test("reopening a goal whose general above is archived says so with its name and reopens nothing (RP-83)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering the reopening without the refusal (g1 comes back open under an archived general).
  const tree = await seedTree(db, person, Date.now());
  await archiveTogether(db, [tree.G, tree.g1, tree.p, tree.g2]);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    await page.getByRole("button", { name: "Reabrir" }).click();
    await expect(page.getByText(`«${tree.names.G}» está archivada. Reábrela primero.`)).toBeVisible();
    const archived = await archivedOf(db, [tree.G, tree.g1, tree.p, tree.g2]);
    expect(Object.values(archived).every((value) => value === true)).toBe(true);
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("reopening the general reopens the goals archived with it and leaves the one archived on its own before (P5)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: reopening the whole branch (g2, archived by hand days earlier, would come back).
  const tree = await seedTree(db, person, Date.now());
  await db`update goals.goals set archived_at = now() - interval '3 days' where id = ${tree.g2}`;
  await archiveTogether(db, [tree.G, tree.g1, tree.p]);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    await expectTitle(page, tree.names.G);
    await page.getByRole("button", { name: "Reabrir" }).click();
    await expect(page.getByRole("button", { name: "Archivar esta meta" })).toBeVisible();
    const archived = await archivedOf(db, [tree.G, tree.g1, tree.p, tree.g2]);
    expect(archived).toEqual({ [tree.G]: false, [tree.g1]: false, [tree.p]: false, [tree.g2]: true });
    // The goal archived on its own no longer counts in the sum above, and the sheet counts only open goals.
    const sheet = await openSheet(page);
    await expect(sheet.getByText(/Con ella se archivan 2 metas/)).toBeVisible();
  } finally {
    await context.close();
  }
});
