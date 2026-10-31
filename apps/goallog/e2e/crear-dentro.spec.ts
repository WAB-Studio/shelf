import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { horizonForWeeks } from "@/lib/day/weeks";
import { todayInZone } from "@/lib/zone";

import { test, expect, openMore } from "./fixtures";

// RP-82, RP-79: a goal is created inside another from that goal's own screen,
// in a sheet, and lives inside the upper goal's span. Every row is seeded under
// the spec's own disposable person (cleared before each test); dates are
// relative to the harness's day, never fixed.

type Db = postgres.Sql;

const WEEKS_LABEL = /^semanas, contando la del /i;
// The upper goal's room: it ends on the Sunday of its week 11.
const ROOM_WEEKS = 11;

async function seedGoal(
  db: Db,
  personId: string,
  name: string,
  opts: { parentId?: string | null; weeks: number },
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, parent_id)
    values (${personId}, ${name}, ${horizonForWeeks(todayInZone(), opts.weeks)}::date, ${opts.parentId ?? null})
    returning id`;
  return goal.id;
}

// General > large (room for 11 weeks): the large goal is the upper goal under test.
async function seedLarge(db: Db, personId: string, stamp: number) {
  const generalName = `General crear ${stamp}`;
  const largeName = `Caso crear ${stamp}`;
  const generalId = await seedGoal(db, personId, generalName, { weeks: 30 });
  const largeId = await seedGoal(db, personId, largeName, { parentId: generalId, weeks: ROOM_WEEKS });
  return { generalId, generalName, largeId, largeName };
}

async function named(db: Db, personId: string, name: string) {
  return db<{ id: string; parent_id: string | null; horizon: string }[]>`
    select id, parent_id, horizon::text as horizon from goals.goals where user_id = ${personId} and name = ${name}`;
}

async function open(browser: Browser, baseURL: string, sessionFile: string, path: string, clock = false) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  await page.goto(path);
  return { context, page };
}

function countActionPosts(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) calls.push(request.url());
  });
  return calls;
}

test("from a large goal, «Añadir meta pequeña» opens the sheet and saving lands on the new goal, inside it (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: createGoal called without parentId (the new goal is born at the top, parent_id null).
  const stamp = Date.now();
  const { largeId, largeName } = await seedLarge(db, person.id, stamp);
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${largeId}`);
  try {
    await openMore(page);
    const add = page.getByRole("button", { name: "Añadir meta pequeña" });
    await expect(add).toBeVisible();
    await add.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(largeName.toUpperCase())).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Una meta pequeña dentro" })).toBeVisible();

    const name = `Leer cap. 3 ${stamp}`;
    await sheet.getByLabel("nombre").fill(name);
    await sheet.getByLabel(WEEKS_LABEL).fill("8");
    await sheet.getByRole("button", { name: "Abrirla", exact: true }).click();

    await page.waitForURL((url) => /\/metas\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(largeId));
    const rows = await named(db, person.id, name);
    expect(rows).toHaveLength(1);
    expect(page.url()).toMatch(new RegExp(`/metas/${rows[0].id}$`));
    expect(rows[0].parent_id).toBe(largeId);
    expect(rows[0].horizon).toBe(horizonForWeeks(todayInZone(), 8));
    await expect(page.getByRole("main").getByText(name, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("while saving, «Abrirla» cannot fire a second time (RP-82)", async ({ person, browser, baseURL, db }) => {
  // Kills: re-enabling «Abrirla» before the response arrives (a second tap sends a second request, a second goal).
  const stamp = Date.now();
  const { largeId } = await seedLarge(db, person.id, stamp);
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${largeId}`);
  try {
    await openMore(page);
    const add = page.getByRole("button", { name: "Añadir meta pequeña" });
    await expect(add).toBeVisible();
    await add.click();
    const sheet = page.getByRole("dialog");
    const name = `Una sola vez ${stamp}`;
    await sheet.getByLabel("nombre").fill(name);
    await sheet.getByLabel(WEEKS_LABEL).fill("4");

    // Hold every action response open so the sheet sits in its pending state.
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });
    const calls = countActionPosts(page);
    const confirm = sheet.getByRole("button", { name: "Abrirla", exact: true });
    await confirm.click();
    await expect.poll(() => calls.length).toBe(1);
    // A tap on a button that is still firing: a disabled button swallows it.
    await confirm.dispatchEvent("click");
    await confirm.dispatchEvent("click");

    await page.waitForURL((url) => /\/metas\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(largeId));
    expect(calls).toHaveLength(1);
    expect(await named(db, person.id, name)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("weeks past the upper goal's end are refused on the client, naming it, with «Abrirla» disabled (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not comparing the weeks with the upper goal's end (the sentence never shows, «Abrirla» stays enabled).
  const stamp = Date.now();
  const { largeId, largeName } = await seedLarge(db, person.id, stamp);
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${largeId}`, true);
  try {
    await openMore(page);
    const add = page.getByRole("button", { name: "Añadir meta pequeña" });
    await expect(add).toBeVisible();
    await add.click();
    const sheet = page.getByRole("dialog");
    const calls = countActionPosts(page);
    const name = `Pasa del final ${stamp}`;
    await sheet.getByLabel("nombre").fill(name);
    const weeks = sheet.getByLabel(WEEKS_LABEL);

    await weeks.fill(String(ROOM_WEEKS));
    await expect(sheet.getByRole("button", { name: "Abrirla", exact: true })).toBeEnabled();
    await expect(sheet.getByText(/^termina el /)).toBeVisible();

    await weeks.fill(String(ROOM_WEEKS + 1));
    await expect(weeks).toHaveAttribute("aria-invalid", "true");
    await expect(
      sheet.getByText(new RegExp(`^Pasa del final de «${largeName}», el .+ Hasta ${ROOM_WEEKS} semanas\\.$`)),
    ).toBeVisible();
    await expect(sheet.getByText(/^termina el /)).toHaveCount(0);
    const confirm = sheet.getByRole("button", { name: "Abrirla", exact: true });
    await expect(confirm).toBeDisabled();
    await confirm.dispatchEvent("click");

    await page.clock.runFor(30_000);
    expect(calls).toEqual([]);
    expect(await named(db, person.id, name)).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("the upper goal archived while the sheet is open: saving says so under the field and writes nothing (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: answering with a generic error (or none) instead of tree.errors.aboveClosed with the upper goal's name.
  const stamp = Date.now();
  const { largeId, largeName } = await seedLarge(db, person.id, stamp);
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${largeId}`);
  try {
    await openMore(page);
    const add = page.getByRole("button", { name: "Añadir meta pequeña" });
    await expect(add).toBeVisible();
    await add.click();
    const sheet = page.getByRole("dialog");
    const name = `Bajo archivada ${stamp}`;
    await sheet.getByLabel("nombre").fill(name);
    await sheet.getByLabel(WEEKS_LABEL).fill("4");

    await db`update goals.goals set archived_at = now() where id = ${largeId}`;
    await sheet.getByRole("button", { name: "Abrirla", exact: true }).click();

    await expect(sheet.getByText(`«${largeName}» está archivada o terminada.`)).toBeVisible();
    await expect(sheet).toBeVisible();
    expect(await named(db, person.id, name)).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("«No abrirla» closes the sheet and creates nothing (RP-82)", async ({ person, browser, baseURL, db }) => {
  // Kills: creating the goal when the sheet closes.
  const stamp = Date.now();
  const { largeId } = await seedLarge(db, person.id, stamp);
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${largeId}`, true);
  try {
    await openMore(page);
    const add = page.getByRole("button", { name: "Añadir meta pequeña" });
    await expect(add).toBeVisible();
    await add.click();
    const sheet = page.getByRole("dialog");
    const calls = countActionPosts(page);
    const name = `No abrirla ${stamp}`;
    await sheet.getByLabel("nombre").fill(name);
    await sheet.getByLabel(WEEKS_LABEL).fill("4");
    await sheet.getByRole("button", { name: "No abrirla" }).click();

    await expect(sheet).toBeHidden();
    await page.clock.runFor(30_000);
    expect(page.url()).toMatch(new RegExp(`/metas/${largeId}$`));
    expect(calls).toEqual([]);
    expect(await named(db, person.id, name)).toHaveLength(0);
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int as count from goals.goals where user_id = ${person.id}`;
    expect(count).toBe(2);
  } finally {
    await context.close();
  }
});

test("a small goal's screen offers no «Añadir meta …» (RP-78, RP-82)", async ({ person, browser, baseURL, db }) => {
  // Kills: offering the button on a goal that already sits at the third level.
  const stamp = Date.now();
  const { largeId } = await seedLarge(db, person.id, stamp);
  const smallId = await seedGoal(db, person.id, `Pequeña crear ${stamp}`, { parentId: largeId, weeks: 4 });
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${smallId}`);
  try {
    await expect(page.getByRole("main").getByText(`Pequeña crear ${stamp}`, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Añadir meta/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Añadir meta/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("on a general goal the button and the title say «grande», and the new goal is a large one (RP-82)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: one fixed title / button for every level.
  const stamp = Date.now();
  const { generalId, generalName } = await seedLarge(db, person.id, stamp);
  const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${generalId}`);
  try {
    await expect(page.getByRole("button", { name: "Añadir meta pequeña" })).toHaveCount(0);
    const add = page.getByRole("button", { name: "Añadir meta grande" });
    await expect(add).toBeVisible();
    await add.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(generalName.toUpperCase())).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Una meta grande dentro" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Una meta pequeña dentro" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
