import { test, expect, visit } from "./fixtures";
import {
  countActionPosts,
  expectTitle,
  goalLink,
  holdActions,
  MINUTES,
  monthsAhead,
  openAs,
  seedGoal,
  seedTree,
} from "./meta-arbol-seed";
import {
  destination,
  escapeRe,
  isPickable,
  noOverflow,
  openMoveSheet,
  parentOf,
  topDestination,
} from "./mover-nota-ayuda";

// Module 872 (b) (RP-82), board `JerarquiaMover`: «Mover bajo otra meta» opens «¿Bajo qué meta?», one
// radio row per destination. Small goals never appear (they admit nothing); a goal's own branch is
// never offered; «Arriba, sin meta encima» only for a goal that has one above; a goal under a general
// becomes large and under a large one small. A refused destination is dimmed and says why.
// Tree: General G > large g1 > small p, and a second large g2 under G (g1 sorts first in the plan).

test("from a small goal: top, the general, both larges (the current one marked), never itself; «Moverla» waits for a change (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not filtering by `moveTargets` / offering the goal itself, no «arriba» for a goal with one above,
  // an enabled «Moverla» before the destination changes.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const sheet = await openMoveSheet(page);
    const top = topDestination(sheet);
    const rows = [top, destination(sheet, tree.names.G), destination(sheet, tree.names.g1), destination(sheet, tree.names.g2)];
    for (const row of rows) await expect(row).toHaveCount(1);
    await expect(sheet.getByRole("radio")).toHaveCount(4);
    await expect(destination(sheet, tree.names.p)).toHaveCount(0);

    await expect(destination(sheet, tree.names.g1)).toBeChecked();
    await expect(destination(sheet, tree.names.g2)).not.toBeChecked();
    await expect(sheet.getByRole("button", { name: "Moverla", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Dejarla donde está", exact: true })).toBeEnabled();

    // The order of the tree: top, the general, then the larges in the plan's order (g1 was opened first).
    const ys = await Promise.all(rows.map(async (row) => (await row.boundingBox())!.y));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));

    // What each row says it becomes: one suelta, one grande (under the general), two pequeñas (under a large).
    await expect(sheet.getByText("queda como una meta suelta")).toHaveCount(1);
    await expect(sheet.getByText("queda como meta grande")).toHaveCount(1);
    await expect(sheet.getByText("queda como meta pequeña")).toHaveCount(2);

    await destination(sheet, tree.names.g2).check();
    await expect(sheet.getByRole("button", { name: "Moverla", exact: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("from a large goal that has none inside: the small one is never offered, itself neither (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering small goals as destinations, or the goal itself.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g2}`);
  try {
    const sheet = await openMoveSheet(page);
    await expect(destination(sheet, tree.names.p)).toHaveCount(0);
    await expect(destination(sheet, tree.names.g2)).toHaveCount(0);
    await expect(topDestination(sheet)).toHaveCount(1);
    await expect(destination(sheet, tree.names.G)).toBeChecked();
    await expect(destination(sheet, tree.names.g1)).toHaveCount(1);
    await expect(sheet.getByRole("radio")).toHaveCount(3);
  } finally {
    await context.close();
  }
});

test("a large goal that holds one never offers its own branch, nor a place that would make a fourth level (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not excluding the branch (a cycle), not refusing the depth the tree allows.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    const sheet = await openMoveSheet(page);
    await expect(destination(sheet, tree.names.g1)).toHaveCount(0);
    await expect(destination(sheet, tree.names.p)).toHaveCount(0);
    // Under the other large, g1 and its small would be four levels deep: not a pick.
    expect(await isPickable(destination(sheet, tree.names.g2))).toBe(false);
    await expect(topDestination(sheet)).toHaveCount(1);
    await expect(destination(sheet, tree.names.G)).toBeChecked();
    await expect(sheet.getByRole("button", { name: "Moverla", exact: true })).toBeDisabled();
  } finally {
    await context.close();
  }
});

test("a goal with nothing above is not offered «arriba»; a general that holds goals has no way to move (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering «Arriba, sin meta encima» to every goal; showing «Mover bajo otra meta» on a general.
  const tree = await seedTree(db, person, Date.now());
  const stamp = Date.now();
  const soloName = `Suelta ${stamp}`;
  const solo = await seedGoal(db, person, { name: soloName, unit: MINUTES, horizon: monthsAhead(2) });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${solo}`);
  try {
    const sheet = await openMoveSheet(page);
    await expect(topDestination(sheet)).toHaveCount(0);
    await expect(destination(sheet, tree.names.G)).toHaveCount(1);
    await expect(destination(sheet, soloName)).toHaveCount(0);
    await expect(destination(sheet, tree.names.p)).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Moverla", exact: true })).toBeDisabled();

    await visit(page, `/metas/${tree.G}`);
    await expectTitle(page, tree.names.G);
    await expect(page.getByRole("button", { name: "Mover bajo otra meta" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("moving the small goal under the other large: parent_id changes and the goal shows under it, no longer under the first (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not refreshing after the move; moving to the wrong row; writing nothing.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const sheet = await openMoveSheet(page);
    await destination(sheet, tree.names.g2).check();
    await sheet.getByRole("button", { name: "Moverla", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => parentOf(db, tree.p)).toBe(tree.g2);

    await visit(page, `/metas/${tree.g2}`);
    await expect(goalLink(page, tree.p)).toBeVisible();
    await visit(page, `/metas/${tree.g1}`);
    await expect(page.locator(`main a[href="/metas/${tree.p}"]`)).toHaveCount(0);
    // The other goals did not move.
    expect(await parentOf(db, tree.g1)).toBe(tree.G);
    expect(await parentOf(db, tree.g2)).toBe(tree.G);
  } finally {
    await context.close();
  }
});

test("«Arriba, sin meta encima» leaves the goal at the top: parent_id is null and no goal lists it inside (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: writing the current parent, or an empty string, for the top.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g2}`);
  try {
    const sheet = await openMoveSheet(page);
    await topDestination(sheet).check();
    await sheet.getByRole("button", { name: "Moverla", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => parentOf(db, tree.g2)).toBeNull();

    await visit(page, `/metas/${tree.G}`);
    await expect(page.locator(`main a[href="/metas/${tree.g2}"]`)).toHaveCount(0);
    await visit(page, `/metas/${tree.g2}`);
    await expect(page.getByRole("button", { name: "Mover bajo otra meta" })).toBeVisible();
    const again = await openMoveSheet(page);
    await expect(topDestination(again)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a root goal moves under a large one and becomes small: the sheet says what each destination makes of it (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: the same hint under every destination; moving a goal that holds goals under a large one.
  const tree = await seedTree(db, person, Date.now());
  const soloName = `Suelta nivel ${Date.now()}`;
  const solo = await seedGoal(db, person, { name: soloName, unit: MINUTES, horizon: monthsAhead(2) });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${solo}`);
  try {
    const sheet = await openMoveSheet(page);
    await expect(sheet.getByText("queda como meta grande")).toHaveCount(1);
    await expect(sheet.getByText("queda como meta pequeña")).toHaveCount(2);
    await destination(sheet, tree.names.g2).check();
    await sheet.getByRole("button", { name: "Moverla", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => parentOf(db, solo)).toBe(tree.g2);
    await visit(page, `/metas/${solo}`);
    // Now small: it holds nothing and offers nothing to be made inside.
    await expect(page.getByRole("link", { name: /Agregar meta/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a destination whose end falls before the goal's is dimmed with its reason, naming it, and cannot be picked (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering every destination alike (no reason, still pickable); a generic reason.
  const tree = await seedTree(db, person, Date.now());
  const earlyName = `Corta ${Date.now()}`;
  const early = await seedGoal(db, person, { name: earlyName, parent: tree.G, unit: MINUTES, horizon: monthsAhead(1) });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const sheet = await openMoveSheet(page);
    expect(await isPickable(destination(sheet, earlyName))).toBe(false);
    await expect(
      sheet.getByText(new RegExp(`Pasa del final de «${escapeRe(earlyName)}», el .+\\.`)).first(),
    ).toBeVisible();
    // The other destinations stay open.
    expect(await isPickable(destination(sheet, tree.names.g2))).toBe(true);
    expect(await parentOf(db, tree.p)).toBe(tree.g1);
    expect(await parentOf(db, early)).toBe(tree.G);
  } finally {
    await context.close();
  }
});

test("while moving, one request leaves and every control of the sheet is inert (RP-82)", async ({ person, browser, baseURL, db }) => {
  // Kills: a second send (double tap), controls still live while the answer is awaited.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const sheet = await openMoveSheet(page);
    await destination(sheet, tree.names.g2).check();
    await holdActions(page);
    const calls = countActionPosts(page);
    const confirm = sheet.getByRole("button", { name: "Moverla", exact: true });
    await confirm.click();
    await expect.poll(() => calls.length).toBe(1);
    await expect(confirm).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Dejarla donde está", exact: true })).toBeDisabled();
    await expect(destination(sheet, tree.names.G)).toBeDisabled();
    await confirm.dispatchEvent("click");
    await confirm.dispatchEvent("click");
    await expect(sheet).toBeHidden();
    expect(calls.length).toBe(1);
    expect(await parentOf(db, tree.p)).toBe(tree.g2);
  } finally {
    await context.close();
  }
});

test("choosing a destination sends nothing; «Dejarla donde está» closes with no request and no change (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: moving as soon as a row is chosen; «Dejarla donde está» that still writes.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openMoveSheet(page);
    await destination(sheet, tree.names.g2).check();
    await topDestination(sheet).check();
    await page.waitForTimeout(500);
    expect(calls.length).toBe(0);
    await sheet.getByRole("button", { name: "Dejarla donde está", exact: true }).click();
    await expect(sheet).toBeHidden();
    await page.waitForTimeout(500);
    expect(calls.length).toBe(0);
    expect(await parentOf(db, tree.p)).toBe(tree.g1);

    // Reopened, it starts again from where the goal is.
    const again = await openMoveSheet(page);
    await expect(destination(again, tree.names.g1)).toBeChecked();
  } finally {
    await context.close();
  }
});

test("a destination archived in another tab: the sheet says so by name, stays open, and nothing changes (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: closing the sheet as if it had moved; showing a generic failure; moving under an archived goal.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const sheet = await openMoveSheet(page);
    await destination(sheet, tree.names.g2).check();
    await db`update goals.goals set archived_at = now() where id = ${tree.g2}`;
    await sheet.getByRole("button", { name: "Moverla", exact: true }).click();
    await expect(sheet.getByText(`«${tree.names.g2}» está archivada o terminada.`)).toBeVisible();
    await expect(sheet).toBeVisible();
    expect(await parentOf(db, tree.p)).toBe(tree.g1);
  } finally {
    await context.close();
  }
});

test("at 360 px, three levels of long names: the sheet and the page do not overflow (RNP-07)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: rows that do not wrap (a long name pushes the sheet past the viewport).
  const stamp = Date.now();
  const long = (label: string) => `${label} con un nombre larguísimo para una meta de tres niveles ${stamp}`;
  const G = await seedGoal(db, person, { name: long("General"), unit: MINUTES, horizon: monthsAhead(5) });
  const g1 = await seedGoal(db, person, { name: long("Grande uno"), parent: G, unit: MINUTES, horizon: monthsAhead(4) });
  await seedGoal(db, person, { name: long("Grande dos"), parent: G, unit: MINUTES, horizon: monthsAhead(4) });
  const p = await seedGoal(db, person, { name: long("Pequeña"), parent: g1, unit: MINUTES, horizon: monthsAhead(3) });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${p}`);
  try {
    await noOverflow(page);
    const sheet = await openMoveSheet(page);
    await expect(destination(sheet, long("Grande dos"))).toBeVisible();
    await noOverflow(page);
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    const scroll = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(scroll).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});
