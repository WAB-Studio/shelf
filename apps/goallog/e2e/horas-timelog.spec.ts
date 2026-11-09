import { test, expect } from "./fixtures";
import { SOURCE_ROWS } from "@/lib/evidence/source-rows";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-146 and RP-151: a TimeLog commitment marks the day by evidence, and only the TimeLog time it does not count waits in the tray.

type Db = Parameters<Parameters<typeof test>[2]>[0]["db"];

// The catalogue is landed by `npm run source:add`, never a migration (RNP-10): a fresh stack has no TimeLog rows.
async function catalogue(db: Db) {
  for (const row of SOURCE_ROWS) {
    await db`
      insert into goals.evidence_sources (key, label_key, unit) values (${row.key}, ${row.labelKey}, ${row.unit})
      on conflict (key) do nothing`;
  }
}

async function seconds(db: Db, personId: string, app: string, amount: number) {
  await db`
    insert into timelog.app_seconds (user_id, device, day, app, seconds)
    values (${personId}, 'e2e', ${todayInZone()}::date, ${app}, ${amount})
    on conflict (user_id, device, day, app) do update set seconds = excluded.seconds`;
}

async function waiting(db: Db, personId: string): Promise<{ minutes: number }[]> {
  return db<{ minutes: number }[]>`
    select minutes from goals.time_entries where user_id = ${personId} and source = 'timelog' and dismissed_at is null
     order by created_at`;
}

test("a VS Code commitment marks the day; only Terminal time waits in the tray, once (RP-146, RP-151)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  await catalogue(db);
  const horizon = civilDateToDate(todayInZone());
  horizon.setUTCDate(horizon.getUTCDate() + 90);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta código ${stamp}`}, ${dateToCivilDate(horizon)}, 'Tiempo', 'minutos', now() - interval '10 days') returning id`;
  const name = `Programar ${stamp}`;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
    values (${person.id}, ${goal.id}, ${name}, 'daily', 'evidence',
            (select id from goals.evidence_sources where key = 'timelog_app_vscode'), 30, now() - interval '10 days')`;
  await seconds(db, person.id, "Code.exe", 3600);
  await seconds(db, person.id, "WindowsTerminal.exe", 900);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const row = page.locator("div:has([data-state])", { hasText: name }).last();
    await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "evidence");
    const tray = page.getByRole("button", { name: "Confirmar las horas que esperan" });
    await expect(tray).toContainText("1 entrada por confirmar · 15 min");

    await page.reload();
    await expect(tray).toContainText("1 entrada por confirmar · 15 min");
    expect(await waiting(db, person.id)).toEqual([{ minutes: 15 }]);

    await seconds(db, person.id, "WindowsTerminal.exe", 1200);
    await page.reload();
    await expect(tray).toContainText("1 entrada por confirmar · 20 min");
    expect(await waiting(db, person.id)).toEqual([{ minutes: 20 }]);

    await tray.click();
    await page.getByRole("dialog").getByRole("button", { name: `Confirmar en Meta código ${stamp}` }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await seconds(db, person.id, "WindowsTerminal.exe", 1500);
    await page.reload();
    await expect(tray).toContainText("1 entrada por confirmar · 5 min");
    const [placed] = await db<{ minutes: number }[]>`select coalesce(sum(minutes), 0)::int as minutes from goals.time_allocations where goal_id = ${goal.id}`;
    expect(placed.minutes).toBe(20);
  } finally {
    await context.close();
    await db`delete from timelog.app_seconds where user_id = ${person.id} and device = 'e2e'`;
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
    await db`delete from goals.time_entries where user_id = ${person.id} and source = 'timelog'`;
  }
});

test("TimeLog's whole total as a commitment covers every minute: nothing waits (RP-146)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  await catalogue(db);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta total ${stamp}`}, 'Tiempo', 'minutos', now() - interval '10 days') returning id`;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
    values (${person.id}, ${goal.id}, ${`Todo ${stamp}`}, 'daily', 'evidence',
            (select id from goals.evidence_sources where key = 'timelog_total'), 30, now() - interval '10 days')`;
  await seconds(db, person.id, "Code.exe", 3600);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const row = page.locator("div:has([data-state])", { hasText: `Todo ${stamp}` }).last();
    await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "evidence");
    await expect(page.getByRole("button", { name: "Confirmar las horas que esperan" })).toHaveCount(0);
    expect(await waiting(db, person.id)).toEqual([]);
  } finally {
    await context.close();
    await db`delete from timelog.app_seconds where user_id = ${person.id} and device = 'e2e'`;
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
