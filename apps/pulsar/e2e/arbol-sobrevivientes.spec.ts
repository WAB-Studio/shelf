import { test, expect } from "./fixtures";
import {
  archiveTogether,
  flat,
  MINUTES,
  mainText,
  monthsAhead,
  openAs,
  seedGoal,
  seedTree,
  today,
} from "./meta-arbol-seed";
import {
  notToday,
  plusDays,
  seedBudget as seedDayBudget,
  seedCommitment as seedDayCommitment,
  seedGoal as seedDayGoal,
} from "./hoy-arbol-seed";
import { destination, openMoveSheet, topDestination } from "./mover-nota-ayuda";

// What the tree's screens owe that the other specs of the tree leave unasserted (RP-79, RP-83, RP-84):
// a goal already archived is not among the goals an archive takes along nor a place to move to, and the
// paper report counts its goals and what stands inside them. Tree: General G > large g1 > small p, and a
// second large g2 under G.

async function openArchiveSheet(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Archivar esta meta" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("archiving a general names the goals still open under it, never one archived before (RP-83)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: listing every goal below, archived ones too, in «Con ella se archivan».
  const tree = await seedTree(db, person, Date.now());
  await archiveTogether(db, [tree.g2]);
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const sheet = await openArchiveSheet(page);
    const text = flat(await sheet.innerText());
    expect(text).toContain("Con ella se archivan 2 metas: ");
    expect(text).toContain(`«${tree.names.g1}»`);
    expect(text).toContain(`«${tree.names.p}»`);
    expect(text).not.toContain(`«${tree.names.g2}»`);
  } finally {
    await context.close();
  }
});

test("moving a goal never offers an archived goal as a place, not even dimmed (RP-82, RP-83)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: listing archived goals among the destinations.
  const tree = await seedTree(db, person, Date.now());
  const closedName = `Archivada ${Date.now()}`;
  await seedGoal(db, person, { name: closedName, unit: MINUTES, horizon: monthsAhead(6), archived: new Date() });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g2}`);
  try {
    const sheet = await openMoveSheet(page);
    await expect(destination(sheet, tree.names.G)).toHaveCount(1);
    await expect(destination(sheet, closedName)).toHaveCount(0);
    await expect(topDestination(sheet)).toHaveCount(1);
    await expect(sheet.getByRole("radio")).toHaveCount(3);
  } finally {
    await context.close();
  }
});

test("the paper report counts its goals, the ones holding goals with what is inside them, and the ended ones (RP-84)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: counting every goal of the tree as a goal of the report, a holder count that ignores how many
  // sit inside, and no count of the ended ones. Three goals: the general (with g1, p and g2 inside), a loose one, an ended one.
  await seedTree(db, person, Date.now());
  await seedGoal(db, person, { name: `Suelta ${Date.now()}`, unit: MINUTES, horizon: monthsAhead(3) });
  const endedAt = new Date(Date.parse(`${today}T12:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
  const ended = await seedGoal(db, person, {
    name: `Terminada ${Date.now()}`,
    unit: MINUTES,
    horizon: monthsAhead(3),
    created: new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 86_400_000),
  });
  await db`update goals.goals set horizon = ${endedAt}::date where id = ${ended}`;
  const { page, context } = await openAs(browser, baseURL, person, "/exportar");
  try {
    await expect(page.getByRole("main").getByText("3 metas ·", { exact: false }).first()).toBeVisible();
    const text = await mainText(page);
    expect(text).toContain("3 metas · una con 3 dentro · 1 terminada");
  } finally {
    await context.close();
  }
});

test("on screen the general's report lists the tasks of the goals inside it, each naming its goal (RP-84)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: no tasks section for a general that has none of its own, a group without the tasks of its goals.
  const tree = await seedTree(db, person, Date.now());
  const month = `${today.slice(0, 7)}-01`;
  const taskName = `Tarea de la pequeña ${Date.now()}`;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${tree.p}, ${taskName}, ${month}::date, 90)`;
  const { page, context } = await openAs(browser, baseURL, person, "/exportar");
  try {
    await expect(page.getByRole("main").getByText(tree.names.G, { exact: true }).first()).toBeVisible();
    const text = await mainText(page);
    expect(text).toContain(`${taskName} · ${tree.names.p}`);
  } finally {
    await context.close();
  }
});

test("on paper the goals inside a general step in by level: the large one, then its small one further (RP-84)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: one indent for every level inside, or none.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, "/exportar");
  try {
    await expect(page.getByRole("main").getByText(tree.names.G, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    // Each goal's name appears twice on paper: in the general's list of what is inside, and above its own part, last.
    const left = async (name: string) => (await page.getByText(name, { exact: true }).locator("visible=true").last().boundingBox())!.x;
    const [general, large, small] = [await left(tree.names.G), await left(tree.names.g1), await left(tree.names.p)];
    expect(large, "the large goal steps in from the general").toBeGreaterThan(general);
    expect(small, "the small goal steps in further than the large one").toBeGreaterThan(large);
  } finally {
    await context.close();
  }
});

// A general G with a large goal L under it, each asking a daily commitment; L plans 5 h this month.
async function seedDayTree(db: Parameters<typeof seedDayGoal>[0], personId: string) {
  const stamp = Date.now();
  const names = { g: `Gen ${stamp}`, l: `Gran ${stamp}`, gRow: `Fila gen ${stamp}`, lRow: `Fila gran ${stamp}` };
  const g = await seedDayGoal(db, personId, names.g);
  const l = await seedDayGoal(db, personId, names.l, g);
  await seedDayBudget(db, personId, l, 300);
  await seedDayCommitment(db, personId, g, names.gRow);
  await seedDayCommitment(db, personId, l, names.lRow);
  return names;
}

async function onDays(browser: import("@playwright/test").Browser, person: import("./fixtures").Person, db: Parameters<typeof seedDayGoal>[0]) {
  const names = await seedDayTree(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  const at = async (path: string) => {
    await page.goto(path);
    await expect(page.getByText(names.gRow).first()).toBeVisible();
  };
  return { names, context, page, at };
}

test("a past day groups by general and says how many the group asked that day (RP-84, RP-06)", async ({ person, browser, db }) => {
  // Kills: a past day drawn flat, with no group label.
  const { names, context, page, at } = await onDays(browser, person, db);
  try {
    await at(`/dia/${plusDays(-1)}`);
    expect((await mainText(page)).toLowerCase()).toContain(`${names.g} · ese día pedía dos`.toLowerCase());
  } finally {
    await context.close();
  }
});

test("a past day's group draws no month line, as today's does (RP-84, RP-28)", async ({ person, browser, db }) => {
  // Kills: the goal's month line inside a group on a day already gone.
  const { names, context, page, at } = await onDays(browser, person, db);
  try {
    await at("/");
    expect(await mainText(page), "today draws it").toMatch(new RegExp(`${names.l} .*\\d+ min de 5 h`, "i"));
    await at(`/dia/${plusDays(-1)}`);
    expect(await mainText(page)).not.toMatch(/min de 5 h/);
  } finally {
    await context.close();
  }
});

test("a past day's group offers no new task, as today's does (RP-84, RP-06)", async ({ person, browser, db }) => {
  // Kills: «Una tarea de …» on a day already gone.
  const { names, context, page, at } = await onDays(browser, person, db);
  try {
    await at("/");
    await expect(page.getByText(`Una tarea de ${names.g}`, { exact: true }), "today offers it").toHaveCount(1);
    await at(`/dia/${plusDays(-1)}`);
    await expect(page.getByText(/Una tarea de/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the places to move to step in by level: a large goal sits further in than the general it is under (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: one flush list of destinations, no indent for the large goals.
  const tree = await seedTree(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.p}`);
  try {
    const sheet = await openMoveSheet(page);
    // The three left edges in one frame, so the sheet's slide-in cannot skew one against another.
    const lefts = () =>
      sheet.evaluate(
        (el, names) => names.map((name) => {
          const hit = [...el.querySelectorAll("*")].find((node) => node.children.length === 0 && node.textContent === name);
          return hit ? Math.round(hit.getBoundingClientRect().left) : -1;
        }),
        [tree.names.G, tree.names.g1, tree.names.g2],
      );
    await expect.poll(async () => {
      const [general, first, second] = await lefts();
      return general >= 0 && first > general && first === second;
    }).toBe(true);
  } finally {
    await context.close();
  }
});

test("a group that asks nothing today has no block on the phone, only on the wide screen (RP-84, RNP-07)", async ({ person, browser, db }) => {
  // Kills: drawing on the phone the block of a general none of whose goals asks anything today.
  const stamp = Date.now();
  const asking = await seedDayGoal(db, person.id, `Pide ${stamp}`);
  await seedDayCommitment(db, person.id, asking, `Fila pide ${stamp}`);
  const silent = await seedDayGoal(db, person.id, `Calla ${stamp}`);
  const silentLarge = await seedDayGoal(db, person.id, `Calla grande ${stamp}`, silent);
  await seedDayBudget(db, person.id, silentLarge, 300);
  await seedDayCommitment(db, person.id, silentLarge, `Fila calla ${stamp}`, { weekdays: [notToday] });
  const add = `Una tarea de Calla ${stamp}`;
  for (const [width, drawn] of [[360, 0], [1200, 1]] as const) {
    const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByText(`Fila pide ${stamp}`).first()).toBeVisible();
      // The wide screen's block is in the page at every width; the phone hides it.
      await expect(page.getByText(add, { exact: true }).locator("visible=true"), `${width}px`).toHaveCount(drawn);
    } finally {
      await context.close();
    }
  }
});

test("opening «mover el final» of a goal that ends the day its general does names no refusal until the count changes (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: judging the sheet's opening count by the week's edge it would write, which passes the general's end.
  let end = monthsAhead(2);
  for (let n = 3; new Date(`${end}T00:00:00Z`).getUTCDay() === 1 && n < 10; n += 1) end = monthsAhead(n);
  const stamp = Date.now();
  const general = await seedGoal(db, person, { name: `Techo ${stamp}`, unit: MINUTES, horizon: end });
  const large = await seedGoal(db, person, { name: `Bajo ${stamp}`, parent: general, unit: MINUTES, horizon: end });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${large}`);
  try {
    await page.getByRole("button", { name: "mover el final" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    expect(flat(await sheet.innerText())).not.toContain(`«Techo ${stamp}»`);
    // Eight weeks more pass the general's end: now the sheet says so.
    const weeks = sheet.getByRole("spinbutton");
    await weeks.fill(String(Number(await weeks.inputValue()) + 8));
    expect(flat(await sheet.innerText())).toContain(`Pasa del final de «Techo ${stamp}»`);
  } finally {
    await context.close();
  }
});
