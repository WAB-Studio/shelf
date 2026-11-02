import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { boxOf } from "./box";

// Against `PULSAR_FAULT_BASE_URL`: a `next start` of the same build with
// `PULSAR_FAULT_SEAM=reading_lookups`, so every read of that source rejects
// and each screen draws RNP-04's notice over what the person declared. The
// control drives the same seed on `PULSAR_BASE_URL`, the ordinary server.
const LIVE = process.env.PULSAR_BASE_URL ?? "http://localhost:3200";

// FuenteCaidaPalabras: one notice, the same words on every screen (RP-07, RNP-10).
// Literals on purpose: a spec that read them from the catalogue would pass on any text.
const NOTE_TITLE = "No pudimos leer una fuente.";
const NOTE_BODY = "Lo que cuenta de ella queda sin marcar hasta que se pueda leer. Lo demás es tuyo y está completo.";

async function expectNote(page: Page, where: string): Promise<void> {
  const note = page.getByRole("status").filter({ hasText: NOTE_TITLE });
  await expect(note, `${where}: one status carries the notice`).toHaveCount(1);
  await expect(note).toContainText(NOTE_TITLE);
  await expect(note).toContainText(NOTE_BODY);
  await expect(page.getByText("sigue aquí")).toHaveCount(0);
  await expect(note).not.toContainText(/diccionario|lectura/i);
}
const FAILURE = "No se pudo abrir";

// The Semana row's mark names its day in full («…, lunes 5: hecho»), read
// back here rather than imported.
const WEEKDAY_LONG = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function markDayLabel(civilDay: string): string {
  const weekdayIndex = (new Date(`${civilDay}T12:00:00Z`).getUTCDay() + 6) % 7;
  return `${WEEKDAY_LONG[weekdayIndex]} ${Number(civilDay.slice(8, 10))}`;
}

type Seed = { goalId: string; goalName: string; tapName: string; evidenceName: string; today: string };

// A goal with a measure, a tap commitment declared today and an evidence one
// on `reading_lookups`. Nothing under `reading.*` is written.
async function seed(db: postgres.Sql, person: Person): Promise<Seed> {
  const stamp = Date.now();
  const goalName = `Meta sin fuente ${stamp}`;
  const tapName = `Marcada a mano ${stamp}`;
  const today = todayInZone();
  const horizonDate = civilDateToDate(today);
  horizonDate.setUTCDate(horizonDate.getUTCDate() + 90);

  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${goalName}, ${dateToCivilDate(horizonDate)}, 'Páginas', 'páginas',
            now() - interval '20 days')
    returning id
  `;
  const [tap] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, ${tapName}, 'daily', 'tap', now() - interval '20 days')
    returning id
  `;
  const evidenceName = `Leída por la fuente ${stamp}`;
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
    values (
      ${person.id}, ${goal.id}, ${evidenceName}, 'daily', 'evidence',
      (select id from goals.evidence_sources where key = 'reading_lookups'), 3,
      now() - interval '20 days'
    )
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, written_at)
    values (${person.id}, ${tap.id}, ${goal.id}, ${today}, now())
  `;
  return { goalId: goal.id, goalName, tapName, evidenceName, today };
}

async function settle(page: Page, content: string): Promise<void> {
  await expect(page.getByText(content).filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
}

test.describe("an evidence source that cannot be read (RNP-04)", () => {
  test("Hoy draws the notice and keeps the declared row", async ({ person, browser, baseURL, db }) => {
    const seeded = await seed(db, person);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await settle(page, seeded.tapName);

      await expectNote(page, "Hoy");
      const row = page.locator("button", { hasText: seeded.tapName });
      await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "declared");
      await expect(page.getByText(FAILURE)).toHaveCount(0);

      // The unreadable source still lets the row say what it asks (RP-08), and
      // never names a source it could not read. Literals on purpose.
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        const evidence = page.locator("div:has([data-state])", { hasText: seeded.evidenceName }).last().locator("visible=true");
        const meta = (await evidence.innerText()).replace(seeded.evidenceName, "").replace(/\s+/g, " ").trim();
        expect(meta, `at ${width}`).toBe("sin leer la fuente · pide 3 búsquedas");
        expect(meta).not.toMatch(/diccionario|lectura|Reading/i);
        await expect(evidence.locator("[data-part='mark'][data-state]")).not.toHaveAttribute("data-state", "evidence");
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
    }
  });

  test("Semana draws the notice and keeps today's declared mark", async ({ person, browser, baseURL, db }) => {
    const seeded = await seed(db, person);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/semana");
      await settle(page, seeded.goalName);

      await expectNote(page, "Semana");
      const mark = page
        .getByRole("main")
        .getByRole("img", { name: `${seeded.tapName}, ${markDayLabel(seeded.today)}: hecho`, exact: true });
      await expect(mark).toHaveAttribute("data-state", "declared");
      await expect(page.getByText(FAILURE)).toHaveCount(0);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
    }
  });

  test("a goal with a measure draws the notice", async ({ person, browser, baseURL, db }) => {
    const seeded = await seed(db, person);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto(`/metas/${seeded.goalId}`);
      await settle(page, seeded.goalName);

      await expectNote(page, "Meta");
      await expect(page.getByText(FAILURE)).toHaveCount(0);

      // `MetaTotal` (399): the total's own line stays, and today's note sits under it.
      const since = page.getByText(/^en total, desde el /).locator("visible=true");
      await expect(since).toHaveCount(1);
      const sinceBox = (await boxOf(since));
      const noteBox = (await boxOf(page.getByRole("status").filter({ hasText: NOTE_TITLE })));
      expect(noteBox.y).toBeGreaterThanOrEqual(sinceBox.y + sinceBox.height - 1);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
    }
  });

  test("the goal's month block says it holds only what was declared, with the declared figure, at 360 and 1280", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // `MetaMesSinEvidencia.dc.html`: 5 declared pages of a
    // 12-page month, the reading source unreadable.
    const seeded = await seed(db, person);
    const monthStart = `${seeded.today.slice(0, 7)}-01`;
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${seeded.goalId}, ${monthStart}::date, 12)
    `;
    const [quantity] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${seeded.goalId}, ${`Páginas ${Date.now()}`}, 'daily', 'quantity', 10, 'páginas',
              now() - interval '20 days')
      returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${seeded.goalId}, ${quantity.id}, ${seeded.today}::date, 5)
    `;
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/metas/${seeded.goalId}`);
        await settle(page, seeded.goalName);

        // The block keeps saying it holds only what the person declared, never naming the source.
        await expect(page.getByText(/^solo lo que dijiste tú/).locator("visible=true")).toHaveCount(1);
        await expect(page.getByText(/^solo lo que dijiste tú/).locator("visible=true")).not.toContainText(/diccionario|lectura/i);
        // The month says its unit once, at the end (no-break space), as the total does.
        const month = page.getByText(/^solo lo que dijiste tú/).locator("visible=true").locator("xpath=..");
        await expect(month).toHaveCount(1);
        await expect(month.locator("p").filter({ hasText: /^5 de 12/ })).toHaveJSProperty("textContent", "5 de 12\u00a0páginas");
        await expect(page.getByText(/llevas \d+ %|bajo el 60 %/).locator("visible=true")).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toBeVisible();
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
    }
  });

  test("the ordinary server draws none of the three notices over the same seed", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // A control is worth something only against a server without the seam. The
    // seam server is `baseURL`: the same seed, session and paths must draw the
    // note there and not here, so this one is a different server and the only
    // difference between the two is the seam.
    expect(new URL(LIVE).origin, "PULSAR_BASE_URL is the seam server").not.toBe(new URL(baseURL!).origin);

    const seeded = await seed(db, person);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: LIVE });
    const seamContext = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      const seamPage = await seamContext.newPage();
      for (const [path, content] of [
        ["/", seeded.tapName],
        ["/semana", seeded.goalName],
        [`/metas/${seeded.goalId}`, seeded.goalName],
      ]) {
        await seamPage.goto(path);
        await settle(seamPage, content);
        await expectNote(seamPage, `${path} on the seam server`);

        await page.goto(path);
        await settle(page, content);
        await expect(page.getByText(NOTE_TITLE)).toHaveCount(0);
        await expect(page.getByText(FAILURE)).toHaveCount(0);
        if (path === "/") {
          // Source read: the same figure, with no «sin leer».
          for (const width of [390, 1440]) {
            await page.setViewportSize({ width, height: 844 });
            const row = page.locator("div:has([data-state])", { hasText: seeded.evidenceName }).last().locator("visible=true");
            const meta = (await row.innerText()).replace(seeded.evidenceName, "").replace(/\s+/g, " ").trim();
            expect(meta, `at ${width}`).toContain("3 búsquedas");
            expect(meta).not.toContain("sin leer");
          }
        }
      }
    } finally {
      await seamContext.close();
      await context.close();
      await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
    }
  });
});
