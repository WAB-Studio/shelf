import { test, expect } from "./fixtures";
import { expectTitle, flat, goalLink, KM, mainText, MINUTES, monthWord, openAs, seedGoal, WORDS } from "./meta-arbol-seed";

// Module 872 (RP-80, RP-81), board `JerarquiaOtraUnidad`: a goal under another that measures in a
// different unit adds nothing to the sum above, and the screen of the goal above says so in a notice
// naming it, only in the months where that goal has an amount. Its own row still reads in its own unit.

test("a goal in km under a goal in minutes is named in a notice and adds nothing to the sum (RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: hiding `outOfUnit` (no notice), or summing the km in (the sum reads 40 km as minutes: «1 h 40 min»).
  const stamp = Date.now();
  const G = await seedGoal(db, person, { name: `General unidad ${stamp}`, unit: MINUTES, budget: 999 });
  await seedGoal(db, person, { name: `Alfa tiempo ${stamp}`, parent: G, unit: MINUTES, budget: 120, fact: 60 });
  const walk = await seedGoal(db, person, { name: `Caminata ${stamp}`, parent: G, unit: KM, budget: 500, fact: 40 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${G}`);
  try {
    await expectTitle(page, `General unidad ${stamp}`);
    await expect(page.getByText(`«Caminata ${stamp}» mide en km y no suma aquí.`)).toBeVisible();

    const text = await mainText(page);
    expect(text).toContain("1 h de 2 h");
    expect(text).not.toContain("1 h 40 min");
    expect(text).not.toContain("16 h 39 min");

    // Its own row keeps its own unit and figure.
    const row = flat(await goalLink(page, walk).innerText());
    expect(row).toContain(`${monthWord} · 40 de 500 km`);
  } finally {
    await context.close();
  }
});

test("a large goal with a small goal in words: the notice names it, the sum is the minutes alone, the row reads in words (RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: the notice drawn per month instead of once per goal in another unit, or the sum counting the words.
  const stamp = Date.now();
  const G = await seedGoal(db, person, { name: `General inglés ${stamp}`, unit: MINUTES });
  const large = await seedGoal(db, person, { name: `Inglés B1 ${stamp}`, parent: G, unit: MINUTES });
  await seedGoal(db, person, { name: `EF SET 36+ ${stamp}`, parent: large, unit: MINUTES, budget: 600, fact: 240 });
  const words = await seedGoal(db, person, { name: `EF SET 41+ ${stamp}`, parent: large, unit: WORDS, budget: 120, fact: 40 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${large}`);
  try {
    await expectTitle(page, `Inglés B1 ${stamp}`);
    await expect(page.getByText(`«EF SET 41+ ${stamp}» mide en palabras y no suma aquí.`)).toBeVisible();
    await expect(page.getByText(/mide en .+ y no suma aquí\./)).toHaveCount(1);

    const text = await mainText(page);
    expect(text).toContain("4 h");
    expect(text).toContain("de 10 h");
    expect(text).toContain("40 % del mes · suma de sus metas");
    expect(text).not.toContain("4 h 40 min");

    expect(flat(await goalLink(page, words).innerText())).toContain(`${monthWord} · 40 de 120 palabras`);
  } finally {
    await context.close();
  }
});

test("a goal in another unit with no amount this month draws no notice, and the sum is still read (RP-80)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: drawing the notice for a goal in another unit whatever its months (it has nothing to add this month).
  const stamp = Date.now();
  const G = await seedGoal(db, person, { name: `General sin aviso ${stamp}`, unit: MINUTES });
  await seedGoal(db, person, { name: `Tiempo ${stamp}`, parent: G, unit: MINUTES, budget: 120, fact: 60 });
  await seedGoal(db, person, { name: `Kilómetros ${stamp}`, parent: G, unit: KM });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${G}`);
  try {
    await expectTitle(page, `General sin aviso ${stamp}`);
    await expect(page.getByText("Metas dentro", { exact: true })).toBeVisible();
    expect(await mainText(page)).toContain("1 h de 2 h");
    await expect(page.getByText(/mide en .+ y no suma aquí\./)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
