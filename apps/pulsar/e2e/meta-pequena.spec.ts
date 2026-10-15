import { test, expect } from "./fixtures";
import { expectTitle, mainText, monthWord, openAs, seedTree } from "./meta-arbol-seed";

// Module 872 (RP-81, RP-82, RP-79), board `JerarquiaMetaPequena`: a small goal names the large goal
// above it only with its back link, opens it, offers no goal inside it (a small goal holds nothing),
// and keeps its own month as its own. Tree: General G > large g1 > small p.

test("a small goal names the large goal above as its back link, and tapping it opens that goal (RP-81)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: a back link to the root list `/metas`, or to the general instead of the large goal above.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    await expectTitle(page, tree.names.p);
    await expect(page.getByText(/^meta pequeña · hasta el /)).toBeVisible();

    const back = page.locator(`main a[href="/metas/${tree.g1}"]:visible`).first();
    await expect(back).toContainText(tree.names.g1);
    // The general above that is not named on this screen: no breadcrumb.
    expect(await mainText(page)).not.toContain(tree.names.G);
    await expect(page.locator(`main a[href="/metas/${tree.G}"]`)).toHaveCount(0);

    await back.click();
    await page.waitForURL(`**/metas/${tree.g1}`);
    await expectTitle(page, tree.names.g1);
  } finally {
    await context.close();
  }
});

test("a small goal offers no entry to create a goal inside it, while its large goal above does (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering «Añadir meta …» by `level` large only (a small goal showing it), or by a goal's having a parent.
  const tree = await seedTree(db, person, Date.now());

  const small = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    await expectTitle(small.page, tree.names.p);
    await expect(small.page.locator(`main a[href="/metas/${tree.g1}"]:visible`).first()).toBeVisible();
    await expect(small.page.getByText(/^Añadir meta/)).toHaveCount(0);
    await expect(small.page.getByText("Metas dentro", { exact: true })).toHaveCount(0);
  } finally {
    await small.context.close();
  }

  const large = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    await expectTitle(large.page, tree.names.g1);
    await expect(large.page.getByRole("button", { name: "Añadir meta pequeña" })).toBeVisible();
  } finally {
    await large.context.close();
  }
});

test("a small goal reads its own month, not a sum of goals, and offers no rhythm of a goal that holds goals (RP-81, RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: labelling a leaf's month «suma de sus metas».
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    await expect(page.getByText(/^meta pequeña · hasta el /)).toBeVisible();
    const text = await mainText(page);
    expect(text).toContain("1 h de 2 h");
    expect(text).not.toMatch(/suma de sus metas/i);
    expect(text).not.toMatch(/mide en .+ y no suma aquí/i);
    // Its month is named by the month's word, as on every goal.
    expect(text.toLowerCase()).toContain(monthWord);
  } finally {
    await context.close();
  }
});
