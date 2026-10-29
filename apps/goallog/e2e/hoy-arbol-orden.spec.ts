import { test, expect } from "./fixtures";
import {
  notToday,
  open,
  seedBudget,
  seedCommitment,
  seedGoal,
  topOf,
  topOfRow,
} from "./hoy-arbol-seed";

// `JerarquiaHoy` (RP-47, RP-84): the groups that ask something today come
// first, in the tree's order among themselves; inside a group the rows follow
// the tree, never the order the goals were created in.

test("a general that asks today stands above an earlier general that asks nothing (RP-47, RP-84)", async ({
  person,
  browser,
  db,
}) => {
  const stamp = Date.now();
  const names = { quiet: `General quieta ${stamp}`, quietLarge: `Grande quieta ${stamp}`, asking: `General que pide ${stamp}` };
  // Created first, so the tree's order alone would put it on top.
  const quiet = await seedGoal(db, person.id, names.quiet);
  const quietLarge = await seedGoal(db, person.id, names.quietLarge, quiet);
  await seedBudget(db, person.id, quietLarge, 600);
  await seedCommitment(db, person.id, quietLarge, `Otro día ${stamp}`, { weekdays: [notToday] });
  const asking = await seedGoal(db, person.id, names.asking);
  await seedCommitment(db, person.id, asking, `Hoy ${stamp}`);

  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await open(page);
    const askingTop = await topOf(page, names.asking);
    const quietTop = await topOf(page, names.quiet);
    const quietLargeTop = await topOf(page, names.quietLarge);
    expect(askingTop).not.toBe(Number.POSITIVE_INFINITY);
    // The quiet general is still on the page, and nothing of it is above the one that asks.
    expect(quietTop).not.toBe(Number.POSITIVE_INFINITY);
    expect(askingTop).toBeLessThan(quietTop);
    expect(askingTop).toBeLessThan(quietLargeTop);
    expect(await topOfRow(page, `Hoy ${stamp}`)).toBeLessThan(quietTop);
  } finally {
    await context.close();
  }
});

test("two generals that both ask keep the tree's order between them (RP-47)", async ({ person, browser, db }) => {
  const stamp = Date.now();
  const first = await seedGoal(db, person.id, `Primera ${stamp}`);
  const second = await seedGoal(db, person.id, `Segunda ${stamp}`);
  await seedCommitment(db, person.id, second, `Fila segunda ${stamp}`);
  await seedCommitment(db, person.id, first, `Fila primera ${stamp}`);

  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await open(page);
    expect(await topOf(page, `Primera ${stamp}`)).toBeLessThan(await topOf(page, `Segunda ${stamp}`));
    expect(await topOfRow(page, `Fila primera ${stamp}`)).toBeLessThan(await topOfRow(page, `Fila segunda ${stamp}`));
  } finally {
    await context.close();
  }
});

test("inside a block the rows follow the tree, not the order the goals were created in (RP-47, RP-84)", async ({
  person,
  browser,
  db,
}) => {
  const stamp = Date.now();
  const general = await seedGoal(db, person.id, `General orden ${stamp}`);
  const large = await seedGoal(db, person.id, `Grande uno ${stamp}`, general);
  const other = await seedGoal(db, person.id, `Grande dos ${stamp}`, general);
  // Created last, yet it sits under the first large goal in the tree.
  const small = await seedGoal(db, person.id, `Chica ${stamp}`, large);
  await seedCommitment(db, person.id, other, `Fila de la segunda ${stamp}`);
  await seedCommitment(db, person.id, small, `Fila de la chica ${stamp}`);
  await seedCommitment(db, person.id, large, `Fila de la primera ${stamp}`);
  const after = await seedGoal(db, person.id, `Otra general ${stamp}`);
  await seedCommitment(db, person.id, after, `Fila ajena ${stamp}`);

  for (const width of [360, 1280]) {
    const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      await open(page);
      const label = await topOf(page, `General orden ${stamp}`);
      const one = await topOfRow(page, `Fila de la primera ${stamp}`);
      const small$ = await topOfRow(page, `Fila de la chica ${stamp}`);
      const two = await topOfRow(page, `Fila de la segunda ${stamp}`);
      const next = await topOf(page, `Otra general ${stamp}`);
      expect(label, `at ${width}`).toBeLessThan(one);
      expect(one, `at ${width}`).toBeLessThan(small$);
      expect(small$, `at ${width}`).toBeLessThan(two);
      expect(two, `at ${width}`).toBeLessThan(next);
    } finally {
      await context.close();
    }
  }
});
