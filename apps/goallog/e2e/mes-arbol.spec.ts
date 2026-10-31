import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, visit } from "./fixtures";
import { todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// `JerarquiaMes` (RP-84, RP-43): «Mes» draws one block per general goal, its
// tasks in tree order, and the loose goal its own block after. It runs on any
// day: every date below is read from the day the app reads (`todayInZone`,
// which `PULSAR_CLOCK` pins on a test server), and the Spanish words of the
// month and the day are derived from it.
const TODAY = todayInZone();
const MONTH = `${TODAY.slice(0, 7)}-01`;
const DAY_MS = 86_400_000;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const MONTH_WORD = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(new Date(`${MONTH}T12:00:00Z`));
const MONTH_TITLE = MONTH_WORD.charAt(0).toUpperCase() + MONTH_WORD.slice(1);
// «Lunes 12 de octubre»
const TODAY_LINE = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
  .format(new Date(`${TODAY}T12:00:00Z`))
  .replace(",", "")
  .replace(/^./, (letter) => letter.toUpperCase());
// Seeded relative to the day the app reads: opened 20 days ago, ending in 250.
const OPENED = shift(TODAY, -20);
const HORIZON = shift(TODAY, 250);

const G = "Product Designer junior";
const G1 = "Caso #1 · Urban Vibes";
const P = "Línea base medida";
const G2 = "EF SET 36+";
const G3 = "Portafolio de casos";
const LOOSE = "Inglés B1/B2 → B2+ laboral";

type Db = postgres.Sql;

let tick = 0;
async function seedGoal(db: Db, personId: string, name: string, parentId: string | null, budget: number | null) {
  tick += 1;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
    values (${personId}, ${name}, ${HORIZON}::date, 'minutos', 'minutos', ${parentId},
            ${`${OPENED}T12:00:00Z`}::timestamptz + ${tick} * interval '1 minute')
    returning id
  `;
  if (budget !== null) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${personId}, ${goal.id}, ${MONTH}::date, ${budget})
    `;
  }
  return goal.id;
}

async function seedTask(db: Db, personId: string, goalId: string, name: string, minutes: number, done = false) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${personId}, ${goalId}, ${name}, ${MONTH}::date, ${minutes})
    returning id
  `;
  if (done) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${personId}, ${goalId}, ${task.id}, ${TODAY}::date)
    `;
    // Hours come from blocks alone (RP-128): the done task's time is a block of its own.
    const [block] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
      values (${personId}, ${goalId}, ${`Bloque ${name}`}, 'daily', 'quantity', 10, 'minutos') returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${personId}, ${goalId}, ${block.id}, ${TODAY}::date, ${minutes})
    `;
  }
}

// G (own month 83 h 20 min, never read) > G1 (10 h, never read: it holds P) > P (30 h); G > G2 (7 h);
// G > G3 (no amount). Reached this month: 2 h + 10 h 30 min = 12 h 30 min of
// 37 h. P's done task is created first so insertion order puts it ahead of
// P's pending ones. The loose goal is created last.
async function seed(db: Db, personId: string) {
  const general = await seedGoal(db, personId, G, null, 5000);
  const large = await seedGoal(db, personId, G1, general, 600);
  const small = await seedGoal(db, personId, P, large, 1800);
  const large2 = await seedGoal(db, personId, G2, general, 420);
  const large3 = await seedGoal(db, personId, G3, general, null);
  const loose = await seedGoal(db, personId, LOOSE, null, null);

  await seedTask(db, personId, small, "Armar el guion de la entrevista", 120, true);
  await seedTask(db, personId, large2, "Cerrar el informe del EF SET", 630, true);
  await seedTask(db, personId, small, "Entrevistar a 5 usuarios", 240);
  await seedTask(db, personId, small, "Redactar el hallazgo principal", 180);
  await seedTask(db, personId, large2, "Una prueba de práctica del EF SET", 120);
  await seedTask(db, personId, large3, "Escribir el portafolio", 60);
  await seedTask(db, personId, large, "Pulir las pantallas del caso", 360);
  await seedTask(db, personId, general, "Revisar el plan con mi mentora", 60);
  await seedTask(db, personId, loose, "Grabar el audio de referencia (semana 1)", 60);
  return { general, large, small, large2, large3, loose };
}

// The G block's rows, in the order a person reads them: the name, then the
// line under it, then the figure at its end (read or not as a separate node).
const ROWS: { name: string; line: string; amount: string }[] = [
  { name: "Revisar el plan con mi mentora", line: "", amount: "1 h" },
  { name: "Pulir las pantallas del caso", line: `${G1} · 6 h`, amount: "6 h" },
  { name: "Entrevistar a 5 usuarios", line: `${P} · 4 h`, amount: "4 h" },
  { name: "Redactar el hallazgo principal", line: `${P} · 3 h`, amount: "3 h" },
  { name: "Una prueba de práctica del EF SET", line: `${G2} · 2 h`, amount: "2 h" },
  { name: "Escribir el portafolio", line: `${G3} · 1 h`, amount: "1 h" },
  { name: "Armar el guion de la entrevista", line: `${P} · 2 h`, amount: "2 h" },
  { name: "Cerrar el informe del EF SET", line: `${G2} · 10 h 30 min`, amount: "10 h 30 min" },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (text: string) => text.replace(/\s+/g, " ").trim();

const lc = (text: string) => text.toLowerCase();

async function mainText(page: Page): Promise<string> {
  // The section label («DE OCTUBRE», the month's own word) sits wherever the worker puts it; it is not a row.
  // Lowercase: the screen sets some lines in capitals, and innerText returns what is drawn.
  // The goals' blocks, not the calendar and the month's figures above them (decided 2026-10-31).
  const blocks = page.locator('[data-part="month-blocks"]');
  const area = (await blocks.count()) > 0 ? blocks : page.locator("main");
  return norm((await area.innerText()).replace(new RegExp(`DE ${MONTH_WORD}`, "gi"), " ")).toLowerCase();
}

async function openMes(page: Page) {
  await visit(page, "/mes");
  await expect(page.getByRole("heading", { level: 2 })).not.toHaveCount(0);
}

test("one block per general goal in tree order, the loose goal its own block after; the general's block holds the tasks of G, g1 and p in tree order (RP-84, RP-43)", async ({
  person,
  db,
  browser,
  baseURL,
}) => {
  await seed(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(MONTH_TITLE);
  await expect(page.getByText(TODAY_LINE, { exact: true })).toBeVisible();
  // Only the general and the loose goal head a block: g1, p, g2 and g3 do not.
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
  const general = page.getByRole("heading", { level: 2, name: G, exact: true });
  const loose = page.getByRole("heading", { level: 2, name: LOOSE, exact: true });
  await expect(general.getByRole("link")).toHaveAttribute("href", new RegExp(`/metas/[0-9a-f-]+/meses/${MONTH.slice(0, 7)}$`));
  expect((await boxOf(general)).y).toBeLessThan((await boxOf(loose)).y);

  // Every task of the tree sits between G's heading and the loose goal's.
  const gY = (await boxOf(general)).y;
  const looseY = (await boxOf(loose)).y;
  for (const { name } of ROWS) {
    const y = (await boxOf(page.getByText(name, { exact: true }).first())).y;
    expect(y, name).toBeGreaterThan(gY);
    expect(y, name).toBeLessThan(looseY);
  }
  const looseTask = (await boxOf(page.getByText("Grabar el audio de referencia (semana 1)", { exact: true }).first())).y;
  expect(looseTask).toBeGreaterThan(looseY);

  // Tree order: G's own, g1, p, g2, g3; the done ones last.
  const text = await mainText(page);
  const at = ROWS.map(({ name }) => text.indexOf(lc(name)));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect(at, "rows in tree order").toEqual([...at].sort((a, b) => a - b));
});

test("a task line names only the goal it comes from, and the general's own task names no goal (RP-84)", async ({ person, db, browser, baseURL }) => {
  await seed(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  const text = await mainText(page);
  const end = text.indexOf(lc(LOOSE));
  ROWS.forEach(({ name, line, amount }, index) => {
    const start = text.indexOf(lc(name));
    const next = index + 1 < ROWS.length ? text.indexOf(lc(ROWS[index + 1].name)) : end;
    const segment = text.slice(start, next).trim();
    const expected = line === "" ? `^${escape(name)}(?: ${escape(amount)})+$` : `^${escape(name)} ${escape(line)}(?: ${escape(amount)})?$`;
    expect(segment, name).toMatch(new RegExp(expected, "i"));
  });
});

test("the general's figure is the sum of its goals, not its own month (RP-80, RP-84)", async ({ person, db, browser, baseURL }) => {
  await seed(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  const text = await mainText(page);
  const header = text.slice(text.indexOf(lc(G)), text.indexOf(lc(ROWS[0].name)));
  expect(header).toContain("12 h 30 min");
  expect(header).toContain("de 37 h");
  // G's stored 83 h 20 min is never read.
  expect(header).not.toMatch(/83 h/);

  // The loose goal keeps its own reading.
  const looseHeader = text.slice(text.indexOf(lc(LOOSE)), text.indexOf(lc("Grabar el audio de referencia (semana 1)")));
  expect(looseHeader).toContain("0 min");
  expect(looseHeader).not.toContain("sin monto este mes");
  await expect(page.getByRole("link", { name: `Planear ${MONTH_WORD}`, exact: true }).last()).toBeVisible();
});

test("a done task sits last in the group, muted, with a full mark (RP-84)", async ({ person, db, browser, baseURL }) => {
  await seed(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  const text = await mainText(page);
  const done = ["Armar el guion de la entrevista", "Cerrar el informe del EF SET"];
  const pending = ROWS.map(({ name }) => name).filter((name) => !done.includes(name));
  const lastPending = Math.max(...pending.map((name) => text.indexOf(lc(name))));
  for (const name of done) expect(text.indexOf(lc(name)), name).toBeGreaterThan(lastPending);

  for (const name of done) {
    const mark = page.getByRole("button", { name: `Deshacer: ${name}`, exact: true });
    await expect(mark.locator("[data-state=declared]")).toHaveCount(1);
  }
  const color = (name: string) =>
    page.getByText(name, { exact: true }).first().evaluate((el) => getComputedStyle(el).color);
  const mutedColor = await color(done[0]);
  expect(mutedColor).toBe(await color(done[1]));
  expect(mutedColor).not.toBe(await color("Entrevistar a 5 usuarios"));
  await expect(page.getByRole("button", { name: "Marcar hecha: Entrevistar a 5 usuarios", exact: true })).toBeVisible();
});

test("an inner goal's «sin monto» notice is not printed inside the general's block; the loose goal prints its own (RP-84)", async ({
  person,
  db,
  browser,
  baseURL,
}) => {
  await seed(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  // g3 has a task and no amount this month; only the loose goal invites a plan, in a link and not a line.
  await expect(page.getByText(/sin monto este mes/)).toHaveCount(0);
  const looseY = (await boxOf(page.getByRole("heading", { level: 2, name: LOOSE, exact: true }))).y;
  const invite = page.getByRole("link", { name: `Planear ${MONTH_WORD}`, exact: true });
  await expect(invite).toHaveCount(1);
  expect((await boxOf(invite)).y).toBeGreaterThan(looseY);
  const text = await mainText(page);
  const block = text.slice(text.indexOf(lc(G)), text.indexOf(lc(LOOSE)));
  expect(block).not.toContain("sin monto");
  expect(block).not.toContain("Planear");
});

test("a task of the small goal is marked done in one tap from the general's block: one POST (RP-84, RP-43)", async ({
  person,
  db,
  browser,
  baseURL,
}) => {
  await seed(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  const mark = page.getByRole("button", { name: "Marcar hecha: Entrevistar a 5 usuarios", exact: true });
  // Page coordinates: the calendar above makes the screen taller than the viewport, and a viewport-relative box moves with the scroll.
  const pageY = (locator: import("@playwright/test").Locator) =>
    locator.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const generalY = await pageY(page.getByRole("heading", { level: 2, name: G, exact: true }));
  const looseY = await pageY(page.getByRole("heading", { level: 2, name: LOOSE, exact: true }));
  const markY = await pageY(mark);
  expect(markY).toBeGreaterThan(generalY);
  expect(markY).toBeLessThan(looseY);

  await mark.click();
  const undo = page.getByRole("button", { name: "Deshacer: Entrevistar a 5 usuarios", exact: true });
  await expect(undo).toBeVisible();
  expect(posts).toHaveLength(1);
  const undoY = await pageY(undo);
  expect(undoY).toBeGreaterThan(generalY);
  expect(undoY).toBeLessThan(looseY);
  const [fact] = await db<{ n: number }[]>`
    select count(*)::int as n from goals.facts f join goals.one_offs o on o.id = f.one_off_id
    where o.user_id = ${person.id} and o.name = 'Entrevistar a 5 usuarios'
  `;
  expect(fact.n).toBe(1);
});

test("with no goal the screen is today's empty one (RP-43)", async ({ person, browser, baseURL }) => {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await visit(page, "/mes");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(MONTH_TITLE);
  await expect(page.getByText(TODAY_LINE, { exact: true })).toBeVisible();
  await expect(page.getByText("Todavía no tienes una meta abierta.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Crear una meta" })).toHaveAttribute("href", "/metas/nueva");
  await expect(page.getByRole("link", { name: "Importar un plan" })).toHaveAttribute("href", "/metas/importar");
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
});

test("with no tree, goals keep the flat blocks: one heading per goal, each with its own tasks (RP-43)", async ({
  person,
  db,
  browser,
  baseURL,
}) => {
  const a = await seedGoal(db, person.id, "Suelta A", null, 600);
  const b = await seedGoal(db, person.id, "Suelta B", null, null);
  await seedTask(db, person.id, a, "Tarea de A", 60);
  await seedTask(db, person.id, b, "Tarea de B", 30);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await openMes(page);

  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
  const text = await mainText(page);
  const a1 = text.indexOf(lc("Suelta A"));
  const b1 = text.indexOf(lc("Suelta B"));
  expect(a1).toBeLessThan(text.indexOf(lc("Tarea de A")));
  expect(text.indexOf(lc("Tarea de A"))).toBeLessThan(b1);
  expect(b1).toBeLessThan(text.indexOf(lc("Tarea de B")));
  expect(text.slice(text.indexOf(lc("Tarea de A")), b1)).not.toContain("suelta a");
  expect(text).toContain(`en ${MONTH_WORD} · sin monto este mes`);
});
