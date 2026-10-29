import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";
import monthMessages from "../messages/es/month.json";
import { boxOf } from "./box";

const owesLine = (month: string, owes: string) =>
  monthMessages.list.owes.replace(/<\/?fig>/g, "").replace("{month}", month).replace("{owes}", owes);

// `MesTodas`, `MesTodasEscritorio`, `MesTodasVacio` (RP-43, RP-31):
// this month of every open goal. Calendar-bound as `mes.spec.ts`: «last
// month» is always the month before today, so the carried task is always there.

const NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function label(month: string): string {
  return NAMES[Number(month.slice(5, 7)) - 1];
}

const today = todayInZone();
const thisMonth = monthOf(today);
const lastMonth = monthOf(dayBefore(thisMonth));
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;
const seg = thisMonth.slice(0, 7);

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string, unit: string | null) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, ${unit}, ${unit}, (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  return goal.id;
}

async function seedTask(
  db: Db,
  personId: string,
  goalId: string,
  name: string,
  month: string,
  estimate: number | null,
  doneOn: string | null = null,
) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${personId}, ${goalId}, ${name}, ${month}::date, ${estimate})
    returning id
  `;
  if (doneOn !== null) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${personId}, ${goalId}, ${task.id}, ${doneOn}::date)
    `;
  }
}

test("each open goal draws its month: the line, the carried task first, the task with no amount; a mark lands done and the goal's month shows it; the name opens the goal's month; nothing overflows (RP-43, RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const timed = await seedGoal(db, person.id, `Inglés ${stamp}`, "minutos");
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${timed}, ${thisMonth}::date, 600)`;
  // Created first on purpose: the carried one must still read first.
  await seedTask(db, person.id, timed, `Propia ${stamp}`, thisMonth, 60);
  await seedTask(db, person.id, timed, `Hecha ${stamp}`, thisMonth, 120, today);
  await seedTask(db, person.id, timed, `Arrastrada ${stamp}`, lastMonth, 180);
  const pages = await seedGoal(db, person.id, `Libros ${stamp}`, "páginas");
  await seedTask(db, person.id, pages, `Capítulo ${stamp}`, thisMonth, 30);
  const bare = await seedGoal(db, person.id, `Mudanza ${stamp}`, null);
  await seedTask(db, person.id, bare, `Avisar ${stamp}`, lastMonth, null);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const [width, height] of [
      [360, 740],
      [390, 844],
      [1280, 800],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto("/mes");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        label(thisMonth).charAt(0).toUpperCase() + label(thisMonth).slice(1),
      );
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(3);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `no overflow at ${width}`,
      ).toBeLessThanOrEqual(width);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mes");

    const timedBlock = page.locator("section", { has: page.getByRole("heading", { name: `Inglés ${stamp}` }) });
    // A done task's 2 h adds nothing to the month: hours come from blocks alone (RP-128).
    await expect(timedBlock.getByText("de 10 h", { exact: true })).toBeVisible();
    await expect(timedBlock.getByText(/incluye .* de tareas hechas/)).toHaveCount(0);
    expect((await timedBlock.innerText()).replace(/\s+/g, " ")).toContain("0 min de 10 h");
    const carriedLabel = timedBlock.getByText(`de ${label(lastMonth)}`, { exact: true });
    const ownLabel = timedBlock.getByText(/^de .* · 3 h$/);
    await expect(carriedLabel).toBeVisible();
    await expect(ownLabel).toBeVisible();
    expect((await boxOf(carriedLabel)).y).toBeLessThan((await boxOf(ownLabel)).y);
    await expect(timedBlock.getByText(owesLine(label(lastMonth), "3 h"))).toBeVisible();

    const pagesBlock = page.locator("section", { has: page.getByRole("heading", { name: `Libros ${stamp}` }) });
    await expect(pagesBlock.getByText(`en ${label(thisMonth)} · sin monto este mes`)).toBeVisible();
    await expect(pagesBlock.getByRole("link", { name: `Planear ${label(thisMonth)}` })).toHaveAttribute(
      "href",
      `/metas/${pages}/meses?planear=${seg}&volver=${encodeURIComponent("/mes")}`,
    );

    const bareBlock = page.locator("section", { has: page.getByRole("heading", { name: `Mudanza ${stamp}` }) });
    await expect(bareBlock.getByText("no mide nada · solo sus tareas")).toBeVisible();
    await expect(bareBlock).toContainText(`Avisar ${stamp}`);
    await expect(bareBlock).toContainText(`de ${label(lastMonth)}`);
    await expect(bareBlock).not.toContainText("debe");

    // The mark: one tap, under five seconds, and the goal's month agrees.
    const mark = page.getByRole("button", { name: `Marcar hecha: Propia ${stamp}` });
    const started = Date.now();
    await mark.click();
    await expect(page.getByRole("button", { name: `Deshacer: Propia ${stamp}` })).toBeVisible({ timeout: 5000 });
    expect(Date.now() - started).toBeLessThan(5000);
    await page.goto(`/metas/${timed}/meses/${seg}`);
    await expect(page.getByRole("button", { name: `Deshacer: Propia ${stamp}` })).toBeVisible();

    // One tap on the name lands on the goal's month, on a target 48px tall.
    await page.goto("/mes");
    const nameLink = page.getByRole("link", { name: `Inglés ${stamp}` });
    await expect(nameLink).toBeVisible();
    expect((await boxOf(nameLink)).height).toBeGreaterThanOrEqual(48);
    await nameLink.click();
    await expect(page).toHaveURL(new RegExp(`/metas/${timed}/meses/${seg}$`));
  } finally {
    await context.close();
  }
});

test("with no open goal the page says so and offers two ways in (RP-43)", async ({
  person,
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/mes");
      await expect(page.getByText("Todavía no tienes una meta abierta.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Crear una meta" })).toHaveAttribute("href", "/metas/nueva");
      await expect(page.getByRole("link", { name: "Importar un plan" })).toHaveAttribute("href", "/metas/importar");
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await context.close();
  }
});

test("with the dictionary unreadable the strip speaks and a goal with no amount collapses to its header and meta (MesTodasSinEvidencia, RP-43, RNP-04)", async ({
  person,
  browser,
  db,
}) => {
  // The fault server: `next start` with `PULSAR_FAULT_SEAM=reading_lookups`.
  const faultBaseURL = process.env.PULSAR_FAULT_BASE_URL;
  if (!faultBaseURL) throw new Error("PULSAR_FAULT_BASE_URL is not set: this spec needs the fault server");

  const stamp = Date.now();
  const timed = await seedGoal(db, person.id, `Inglés ${stamp}`, "minutos");
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${timed}, ${thisMonth}::date, 600)`;
  await seedTask(db, person.id, timed, `Con monto ${stamp}`, thisMonth, 180);
  const pages = await seedGoal(db, person.id, `Libros ${stamp}`, "páginas");
  await seedTask(db, person.id, pages, `Capítulo ${stamp}`, thisMonth, 30);
  const bare = await seedGoal(db, person.id, `Mudanza ${stamp}`, null);
  await seedTask(db, person.id, bare, `Primera ${stamp}`, thisMonth, null, today);
  await seedTask(db, person.id, bare, `Segunda ${stamp}`, thisMonth, null);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: faultBaseURL });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mes");
    // FuenteCaidaPalabras: the same words as Hoy, Semana and Meta, naming no source.
    const note = page.getByRole("status").filter({ hasText: "No pudimos leer una fuente." });
    await expect(note).toHaveCount(1);
    await expect(note).toContainText(
      "Lo que cuenta de ella queda sin marcar hasta que se pueda leer. Lo demás es tuyo y está completo.",
    );
    await expect(note).not.toContainText(/diccionario|lectura/i);
    const block = (name: string) => page.locator("section", { has: page.getByRole("heading", { name: `${name} ${stamp}` }) });

    await expect(block("Inglés").getByText("solo lo que dijiste tú")).toBeVisible();
    await expect(block("Inglés")).toContainText(`Con monto ${stamp}`);

    await expect(block("Libros").getByText(`en ${label(thisMonth)} · sin monto este mes`)).toBeVisible();
    await expect(block("Libros")).not.toContainText(`Capítulo ${stamp}`);
    await expect(block("Libros").getByRole("link", { name: /^Planear/ })).toHaveCount(0);

    await expect(block("Mudanza").getByText("no mide nada · 1 de 2 tareas hechas")).toBeVisible();
    await expect(block("Mudanza")).not.toContainText(`Segunda ${stamp}`);
    await expect(block("Mudanza").getByRole("button")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
