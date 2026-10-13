import { test, expect, visit } from "./fixtures";
import {
  archiveTogether,
  expectTitle,
  flat,
  goalLink,
  mainText,
  monthWord,
  openAs,
  seedGoal,
  seedTree,
  MINUTES,
  today,
} from "./meta-arbol-seed";

// Module 872 (RP-81, RP-80, RP-79, RP-82), boards `JerarquiaMetaGeneral` and the large goal of
// `JerarquiaMetaPequena`: the screen of a goal that holds goals names the goal above and opens it,
// lists the goals below with their month, reads its own month as their sum and offers no rhythm and
// no amount. Tree: General G > large g1 > small p, and a second large g2 under G. Words from
// `messages/es/tree.json`. Run at 360 px, the phone the boards are drawn on.

test("the general lists its large goals in plan order, each with its month, its count and a link to its own screen (RP-81)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: listing the goals without their month («octubre · 1 h de 2 h» gone) or without «· 1 meta»; sorting by name.
  const stamp = Date.now();
  const tree = await seedTree(db, person, stamp);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    await expectTitle(page, tree.names.G);
    await expect(page.getByText(/^meta general · hasta el /)).toBeVisible();
    await expect(page.getByText("Metas dentro", { exact: true })).toBeVisible();

    const first = goalLink(page, tree.g1);
    const second = goalLink(page, tree.g2);
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    const hrefs = await page.locator("main a[href^='/metas/']:visible").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")),
    );
    expect(hrefs.indexOf(`/metas/${tree.g1}`)).toBeGreaterThanOrEqual(0);
    expect(hrefs.indexOf(`/metas/${tree.g1}`)).toBeLessThan(hrefs.indexOf(`/metas/${tree.g2}`));

    // g1 holds p: its month is p's, and it says it holds one goal. g2 is a leaf: no count.
    const firstText = flat(await first.innerText());
    expect(firstText).toContain(tree.names.g1);
    expect(firstText).toContain(`${monthWord} · 1 h de 2 h`);
    expect(firstText).toMatch(/hasta el .+ · 1 meta$/);
    const secondText = flat(await second.innerText());
    expect(secondText).toContain(tree.names.g2);
    expect(secondText).toContain(`${monthWord} · 30 min de 1 h`);
    expect(secondText).toMatch(/hasta el [^·]+$/);

    // The small goal is not a row of the general: only the goals directly under it.
    await expect(goalLink(page, tree.p)).toHaveCount(0);

    await second.click();
    await page.waitForURL(`**/metas/${tree.g2}`);
    await expectTitle(page, tree.names.g2);
  } finally {
    await context.close();
  }
});

test("the general offers «Agregar meta grande» and no «Mover bajo otra meta» (RP-82, RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering a move on a general (it has nothing above to move under), or no entry to create inside.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    await expect(page.getByText("Metas dentro", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agregar meta grande" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agregar meta pequeña" })).toHaveCount(0);
    await expect(page.getByText("Mover bajo otra meta")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the general reads its month as the sum of its goals, never its own stored amount, and an archived goal adds nothing (RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: reading the general's own month (999 min = «16 h 39 min»), or summing an archived goal in (600 min planned).
  const tree = await seedTree(db, person, Date.now());
  const archivedChild = await seedGoal(db, person, {
    name: `Archivada ${Date.now()}`,
    parent: tree.G,
    unit: MINUTES,
    budget: 600,
    fact: 300,
  });
  await archiveTogether(db, [archivedChild]);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    await expectTitle(page, tree.names.G);
    const text = await mainText(page);
    // 120 + 60 planned, 60 + 30 reached.
    expect(text).toContain("1 h 30 min");
    expect(text).toMatch(/de 3 h(?!\s*\d+\s*min)/);
    expect(text).toContain("50 % del mes · suma de sus metas");
    expect(text).not.toContain("16 h 39 min");
    expect(text).not.toContain("12 h 57 min");
    expect(text).not.toContain("13 h");
    expect(text).not.toContain("10 h");
  } finally {
    await context.close();
  }
});

test("the general offers no rhythm, no plan and no «Planear», in a month with an amount or without one (RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: leaving the link to `/plan` on a goal that holds goals, or its «Planear {mes}» button.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    await expectTitle(page, tree.names.G);
    await expect(page.getByText("Metas dentro", { exact: true })).toBeVisible();
    const text = await mainText(page);
    expect(text).not.toMatch(/el plan/i);
    expect(text).not.toMatch(/armar/i);
    expect(text).not.toMatch(/planear/i);
    expect(text).not.toMatch(/ritmo/i);
    await expect(page.locator("main a[href*='/plan']")).toHaveCount(0);
    // «Ver por mes» stays: the sum is read there.
    await expect(page.locator(`main a[href="/metas/${tree.G}/meses"]:visible`)).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("a general whose goals cover no amount this month says «Sin monto este mes.» and offers no «Planear» (RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering «Planear {mes}» on a goal that holds goals (it has no amount of its own to give).
  const stamp = Date.now();
  const G = await seedGoal(db, person, { name: `General sin monto ${stamp}`, unit: MINUTES, budget: 999 });
  await seedGoal(db, person, { name: `Grande sin monto ${stamp}`, parent: G, unit: MINUTES });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${G}`);
  try {
    await expect(page.getByText("Sin monto este mes.")).toBeVisible();
    const text = await mainText(page);
    expect(text).not.toMatch(/planear/i);
    expect(text).not.toContain("16 h 39 min");
  } finally {
    await context.close();
  }
});

test("the large goal names the general above and opens it, lists its small goal and offers «Agregar meta pequeña» (RP-81, RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: no line above, a link to `/metas` instead of the goal above, or no entry to create inside a large goal.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    await expectTitle(page, tree.names.g1);
    await expect(page.getByText(/^meta grande · hasta el /)).toBeVisible();

    const above = page.locator(`main a[href="/metas/${tree.G}"]:visible`).first();
    await expect(above).toContainText(tree.names.G);

    const row = goalLink(page, tree.p);
    await expect(row).toBeVisible();
    const text = flat(await row.innerText());
    expect(text).toContain(tree.names.p);
    expect(text).toContain(`${monthWord} · 1 h de 2 h`);
    expect(text).toMatch(/hasta el [^·]+$/);

    await expect(page.getByRole("button", { name: "Agregar meta pequeña" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agregar meta grande" })).toHaveCount(0);

    await above.click();
    await page.waitForURL(`**/metas/${tree.G}`);
    await expectTitle(page, tree.names.G);
  } finally {
    await context.close();
  }
});

test("an archived branch offers no creating inside, no move and no archive, and still names the goal above (RP-81, RP-24)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering «Agregar meta …» or «Mover bajo otra meta» on an archived goal.
  const tree = await seedTree(db, person, Date.now());
  await archiveTogether(db, [tree.G, tree.g1, tree.p, tree.g2]);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    await expectTitle(page, tree.names.g1);
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await expect(page.locator(`main a[href="/metas/${tree.G}"]:visible`).first()).toContainText(tree.names.G);
    await expect(page.getByRole("button", { name: /^Agregar meta/ })).toHaveCount(0);
    await expect(page.getByText("Mover bajo otra meta")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archivar esta meta" })).toHaveCount(0);
  } finally {
    await context.close();
  }

  const general = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    await expectTitle(general.page, tree.names.G);
    await expect(general.page.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await expect(general.page.getByRole("button", { name: /^Agregar meta/ })).toHaveCount(0);
    await expect(general.page.getByText("Mover bajo otra meta")).toHaveCount(0);
  } finally {
    await general.context.close();
  }
});

test("an ended goal inside the tree offers no creating inside and no move, and still names the goal above (RP-81, RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: offering «Agregar meta pequeña» or «Mover bajo otra meta» on a goal whose end has arrived.
  const stamp = Date.now();
  const G = await seedGoal(db, person, { name: `General terminada ${stamp}`, unit: MINUTES, horizon: today });
  const g1 = await seedGoal(db, person, { name: `Grande terminada ${stamp}`, parent: G, unit: MINUTES, horizon: today });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${g1}`);
  try {
    await expectTitle(page, `Grande terminada ${stamp}`);
    await expect(page.getByText(/^terminó /i).first()).toBeVisible();
    await expect(page.locator(`main a[href="/metas/${G}"]:visible`).first()).toContainText(`General terminada ${stamp}`);
    await expect(page.getByRole("button", { name: /^Agregar meta/ })).toHaveCount(0);
    await expect(page.getByText("Mover bajo otra meta")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a goal with no goals around it reads as it always did: no line above, no inside, no sum (RP-81)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: drawing «arriba: —» or an empty «Metas dentro» on a lone goal.
  const lone = await seedGoal(db, person, { name: `Sola ${Date.now()}`, unit: MINUTES, budget: 120, fact: 60 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${lone}`);
  try {
    await expect(page.getByText(/^meta · abierta el /)).toBeVisible();
    const text = await mainText(page);
    expect(text).not.toMatch(/Metas dentro/i);
    expect(text).not.toMatch(/suma de sus metas/i);
    expect(text).not.toMatch(/meta (general|grande|pequeña) ·/i);
    expect(text).not.toContain("—");
    await expect(page.locator("main a[href='/metas']:visible")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("three levels of long names at 360 px: nothing overflows on the general, the large or the small goal (RNP-07)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: a row whose long name or figure line pushes the page past the phone's width.
  const stamp = Date.now();
  const long = (label: string) => `${label} con un nombre larguísimo que no cabe en una sola línea ${stamp}`;
  const G = await seedGoal(db, person, { name: long("General"), unit: MINUTES });
  const g1 = await seedGoal(db, person, { name: long("Grande"), parent: G, unit: MINUTES, budget: 5400, fact: 2700 });
  const p = await seedGoal(db, person, { name: long("Pequeña"), parent: g1, unit: MINUTES, budget: 2700, fact: 1350 });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    // Each screen draws the goal it lists below or the one above it, in the long name.
    for (const [id, name, linked] of [[G, long("General"), g1], [g1, long("Grande"), p], [p, long("Pequeña"), g1]] as const) {
      await visit(page, `/metas/${id}`);
      await expectTitle(page, name);
      await expect(goalLink(page, linked)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      const boxes = await page.locator("main a:visible, main button:visible").evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().right),
      );
      for (const right of boxes) expect(right).toBeLessThanOrEqual(360.5);
    }
  } finally {
    await context.close();
  }
});
