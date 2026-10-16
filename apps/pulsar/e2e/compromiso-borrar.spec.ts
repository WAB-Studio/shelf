import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { test, expect, settled } from "./fixtures";
import type { Person } from "./fixtures";
import { holdActions, type Db } from "./meta-arbol-seed";
import { MINUTES, dialog, mainLower, postCounter, seedOpenGoal, visit } from "./metas-sin-final-seed";
import { TODAY, TODAY_INDEX, drawn, seedFact, seedHabit, shift } from "./sin-final-seed";

// Module 1015, RP-127: a commitment no fact names changes its cadence or goes; one a fact names is only
// retired. Written from the contract (private/asignaciones/1015.md) before the screen exists. Every test
// names the mutation that kills it. A locator that never appears fails in 6 s with its own name.
test.use({ actionTimeout: 6000 });

const FACT_REFUSAL = "Ya hay días hechos con este compromiso: se retira, no se borra.";
const WEEKS_BOUND = "Escribe cuántas veces por semana, un número entero entre 1 y 7.";
const DAYS_BOUND = "Escribe cada cuántos días, un número entero entre 1 y 365.";

type Kind = "daily" | "weekdays" | "times_per_week" | "every_n_days" | "times_per_month";

async function seedCommitment(
  db: Db,
  person: Person,
  goalId: string,
  name: string,
  cadence: { kind: Kind; n?: number; days?: number[] } = { kind: "daily" },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays, satisfaction,
                                   target_quantity, unit, created_at)
    values (${person.id}, ${goalId}, ${name}, ${cadence.kind}, ${cadence.n ?? null}, ${cadence.days ?? null},
            'quantity', 15, 'minutos', now() - interval '30 days')
    returning id`;
  return row.id;
}

async function rowsOf(db: Db, id: string) {
  return db<
    {
      cadence_kind: string;
      cadence_n: number | null;
      cadence_weekdays: number[] | null;
      satisfaction: string;
      target_quantity: number | null;
      unit: string | null;
    }[]
  >`select cadence_kind, cadence_n, cadence_weekdays, satisfaction, target_quantity, unit
    from goals.commitments where id = ${id}`;
}

const rowOnGoal = (page: Page, name: string): Locator => page.locator("main button", { hasText: name });

async function openSheet(page: Page, name: string): Promise<Locator> {
  await rowOnGoal(page, name).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Retirarlo?" })).toBeVisible();
  return sheet;
}

// The acts of a sheet in the order the DOM holds them: buttons and links alike.
const actsOf = (sheet: Locator) => sheet.locator("button, a").allInnerTexts();

// A weekday that is not today's, ISO numbered.
const NOT_TODAY = ((TODAY_INDEX + 3) % 7) + 1;

const mainOf = async (page: Page) => drawn(await page.locator("main").innerText());

test.describe("the sheet of a live commitment (RP-127)", () => {
  test("with a fact it is today's sheet, word for word: two buttons, no delete, no cadence", async ({ person, browser, baseURL, db }) => {
    // Kills: offering the delete or the cadence on `factDayCount >= 0` instead of `=== 0`.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    await seedFact(db, person.id, id, goal, shift(TODAY, -1), 15);
    await seedFact(db, person.id, id, goal, shift(TODAY, -2), 15);
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const sheet = await openSheet(page, "Estirar");
      await expect(sheet).toContainText(
        "Deja de pedirse desde mañana. Las semanas que ya gobernó siguen leyéndose igual, y los 2 días en que lo hiciste siguen ahí.",
      );
      expect((await actsOf(sheet)).map((text) => text.trim())).toEqual(["Retirarlo", "Dejarlo como está"]);
      await expect(sheet.getByRole("button", { name: /Borrar/ })).toHaveCount(0);
      await expect(sheet.getByRole("link", { name: /Cambiar/ })).toHaveCount(0);
      await expect(sheet.getByText("Cambiar la frecuencia")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("without a fact it offers «Retirarlo», «Cambiar la frecuencia» and «Borrar el compromiso», in that order, the change a link to its page", async ({ person, browser, baseURL, db }) => {
    // Kills: hiding the delete; hiding the cadence link; the delete drawn above «Retirarlo»; a button where the link goes.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const sheet = await openSheet(page, "Estirar");
      await expect(sheet).toContainText("Deja de pedirse desde mañana. Las semanas que ya gobernó siguen leyéndose igual.");
      await expect(sheet).not.toContainText("en que lo hiciste");
      const acts = (await actsOf(sheet)).map((text) => text.trim());
      const at = (label: string) => acts.indexOf(label);
      expect(at("Retirarlo")).toBeGreaterThanOrEqual(0);
      expect(at("Cambiar la frecuencia")).toBeGreaterThan(at("Retirarlo"));
      expect(at("Borrar el compromiso")).toBeGreaterThan(at("Cambiar la frecuencia"));
      await expect(sheet.getByRole("link", { name: "Cambiar la frecuencia", exact: true })).toHaveAttribute(
        "href",
        `/metas/${goal}/compromisos/${id}`,
      );
    } finally {
      await context.close();
    }
  });

  test("«Retirarlo» still retires from the three-act sheet and writes retired_at", async ({ person, browser, baseURL, db }) => {
    // Kills: the new acts replacing or rewiring the retire.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const sheet = await openSheet(page, "Estirar");
      await expect(sheet.getByRole("button", { name: "Borrar el compromiso", exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: "Retirarlo", exact: true }).click();
      await expect(rowOnGoal(page, "Estirar")).toContainText("retirado");
      const [row] = await db<{ retired_at: string | null }[]>`select retired_at from goals.commitments where id = ${id}`;
      expect(row.retired_at).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});

test.describe("the delete (RP-127)", () => {
  test("«Borrar el compromiso» opens a second sheet with «Borrarlo» solid and «Dejarlo como está» outline", async ({ person, browser, baseURL, db }) => {
    // Kills: deleting on the first tap; a confirm that is not the solid button; no way to keep it.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const posts = postCounter(page);
      const sheet = await openSheet(page, "Estirar");
      await sheet.getByRole("button", { name: "Borrar el compromiso", exact: true }).click();
      await expect(page.getByText("Nadie lo ha hecho todavía: se borra sin dejar rastro. Retirarlo, en cambio, lo deja en la lista.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Borrarlo", exact: true })).toHaveClass(/\bsolid\b/);
      await expect(page.getByRole("button", { name: "Dejarlo como está", exact: true })).toHaveClass(/\boutline\b/);
      expect(posts).toHaveLength(0);
      expect(await rowsOf(db, id)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("cancelled: «Dejarlo como está» closes the sheet, the row stays and no request left the page", async ({ person, browser, baseURL, db }) => {
    // Kills: a cancel that calls the act.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const posts = postCounter(page);
      const sheet = await openSheet(page, "Estirar");
      await sheet.getByRole("button", { name: "Borrar el compromiso", exact: true }).click();
      await page.getByRole("button", { name: "Dejarlo como está", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(rowOnGoal(page, "Estirar")).toBeVisible();
      expect(posts).toHaveLength(0);
      expect(await rowsOf(db, id)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("pending: both buttons are disabled while the act runs and a second tap sends no second request", async ({ person, browser, baseURL, db }) => {
    // Kills: dropping the pending guard (a double tap writes twice, the buttons stay live).
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const sheet = await openSheet(page, "Estirar");
      await sheet.getByRole("button", { name: "Borrar el compromiso", exact: true }).click();
      await holdActions(page, 1500);
      const posts = postCounter(page);
      const confirm = page.getByRole("button", { name: "Borrarlo", exact: true });
      const keep = page.getByRole("button", { name: "Dejarlo como está", exact: true });
      await confirm.click();
      await expect(confirm).toBeDisabled();
      await expect(keep).toBeDisabled();
      await confirm.click({ force: true });
      await expect(rowOnGoal(page, "Estirar")).toHaveCount(0);
      expect(posts).toHaveLength(1);
      expect(await rowsOf(db, id)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("done: the row leaves the goal's screen without a reload, the database holds no row, and Hoy, Semana and Mes stop drawing it", async ({ person, browser, baseURL, db }) => {
    // Kills: no `router.refresh` after the act (the row stays on the screen); a delete that retires instead of deleting.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    await seedCommitment(db, person, goal, "Caminar");
    const { page, context } = await visit(browser, baseURL, person, "/", 360);
    try {
      expect(await mainOf(page), "control: Hoy asks it").toContain("estirar");
      await page.goto(`/metas/${goal}`);
      await settled(page);
      const sheet = await openSheet(page, "Estirar");
      await sheet.getByRole("button", { name: "Borrar el compromiso", exact: true }).click();
      await page.getByRole("button", { name: "Borrarlo", exact: true }).click();
      await expect(rowOnGoal(page, "Estirar")).toHaveCount(0);
      await expect(dialog(page)).toHaveCount(0);
      await expect(rowOnGoal(page, "Caminar")).toBeVisible();
      expect(await rowsOf(db, id)).toHaveLength(0);
      for (const path of ["/", "/semana", "/mes"]) {
        await page.goto(path);
        await settled(page);
        expect(await mainOf(page), path).not.toContain("estirar");
      }
      await page.goto("/");
      await settled(page);
      expect(await mainOf(page)).toContain("caminar");
    } finally {
      await context.close();
    }
  });

  test("refused: a fact landed while the sheet was open, so the sentence is shown and the row stays", async ({ person, browser, baseURL, db }) => {
    // Kills: swallowing the act's error (the sheet closes as if it had worked); a delete that ignores the fact.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar");
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const sheet = await openSheet(page, "Estirar");
      await seedFact(db, person.id, id, goal, shift(TODAY, -1), 15);
      await sheet.getByRole("button", { name: "Borrar el compromiso", exact: true }).click();
      await page.getByRole("button", { name: "Borrarlo", exact: true }).click();
      await expect(dialog(page).getByText(FACT_REFUSAL)).toBeVisible();
      await expect(rowOnGoal(page, "Estirar")).toHaveCount(1);
      expect(await rowsOf(db, id)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});

test.describe("the cadence page of a commitment (RP-127, RP-12)", () => {
  const path = (goal: string, id: string) => `/metas/${goal}/compromisos/${id}`;
  const chip = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

  test("opens with the current cadence chosen and its numbers filled", async ({ person, browser, baseURL, db }) => {
    // Kills: chips that default to «todos los días» whatever the row holds; a count field left empty.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const days = await seedCommitment(db, person, goal, "Dos días", { kind: "weekdays", days: [2, 4] });
    const week = await seedCommitment(db, person, goal, "Tres a la semana", { kind: "times_per_week", n: 3 });
    const every = await seedCommitment(db, person, goal, "Cada nueve", { kind: "every_n_days", n: 9 });
    const month = await seedCommitment(db, person, goal, "Cuatro al mes", { kind: "times_per_month", n: 4 });
    const daily = await seedCommitment(db, person, goal, "Diario");
    const open = (id: string) => visit(browser, baseURL, person, path(goal, id), 360);
    {
      const { page, context } = await open(days);
      try {
        await expect(chip(page, "días sueltos")).toHaveAttribute("aria-pressed", "true");
        await expect(chip(page, "M")).toHaveAttribute("aria-pressed", "true");
        await expect(chip(page, "J")).toHaveAttribute("aria-pressed", "true");
        await expect(chip(page, "L")).toHaveAttribute("aria-pressed", "false");
        await expect(chip(page, "todos los días")).toHaveAttribute("aria-pressed", "false");
      } finally {
        await context.close();
      }
    }
    for (const [id, kind, label, value] of [
      [week, "veces por semana", "veces por semana", "3"],
      [every, "cada tantos días", "cada cuántos días", "9"],
      [month, "veces al mes", "veces al mes", "4"],
    ] as const) {
      const { page, context } = await open(id);
      try {
        await expect(chip(page, kind)).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("spinbutton", { name: label })).toHaveValue(value);
        await expect(chip(page, "todos los días")).toHaveAttribute("aria-pressed", "false");
      } finally {
        await context.close();
      }
    }
    const { page, context } = await open(daily);
    try {
      await expect(chip(page, "todos los días")).toHaveAttribute("aria-pressed", "true");
      await expect(chip(page, "días sueltos")).toHaveAttribute("aria-pressed", "false");
    } finally {
      await context.close();
    }
  });

  test("saved from the sheet's link: the row changes its cadence, keeps what satisfies it, the screen says the new words", async ({ person, browser, baseURL, db }) => {
    // Kills: saving through `addCommitment` (a second row, the old cadence stays); an edit that also rewrites the amount.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar", { kind: "times_per_week", n: 3 });
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      expect(await mainOf(page)).toContain("3 veces por semana");
      const sheet = await openSheet(page, "Estirar");
      await sheet.getByRole("link", { name: "Cambiar la frecuencia", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goal}/compromisos/${id}$`));
      await chip(page, "cada tantos días").click();
      await page.getByRole("spinbutton", { name: "cada cuántos días" }).fill("5");
      await page.getByRole("button", { name: /^Guardar/ }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goal}$`));
      const [row] = await rowsOf(db, id);
      expect(row).toMatchObject({ cadence_kind: "every_n_days", cadence_n: 5, cadence_weekdays: null });
      expect(row).toMatchObject({ satisfaction: "quantity", target_quantity: 15, unit: "minutos" });
      const [{ n }] = await db<{ n: string }[]>`select count(*)::text as n from goals.commitments where goal_id = ${goal}`;
      expect(Number(n)).toBe(1);
      const text = await mainOf(page);
      expect(text).toContain("cada 5 días");
      expect(text).not.toContain("3 veces por semana");
    } finally {
      await context.close();
    }
  });

  test("saved: Hoy asks by the new days, not the old ones", async ({ person, browser, baseURL, db }) => {
    // Kills: a save that leaves the old days in the engine's input (Hoy not revalidated, or weekdays not cleared).
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar", { kind: "weekdays", days: [NOT_TODAY] });
    const { page, context } = await visit(browser, baseURL, person, "/", 360);
    try {
      expect(await mainOf(page), "control: not asked today").not.toContain("estirar");
      await page.goto(path(goal, id));
      await settled(page);
      await chip(page, "todos los días").click();
      await page.getByRole("button", { name: /^Guardar/ }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goal}$`));
      await page.goto("/");
      await settled(page);
      expect(await mainOf(page)).toContain("estirar");
      expect((await rowsOf(db, id))[0]).toMatchObject({ cadence_kind: "daily", cadence_weekdays: null });
    } finally {
      await context.close();
    }
  });

  test("a count past RP-12's bound is refused on the page with its sentence, no request and no change", async ({ person, browser, baseURL, db }) => {
    // Kills: dropping the client-side bound (the request leaves); a page that saves an out-of-range count.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const week = await seedCommitment(db, person, goal, "Semanal", { kind: "times_per_week", n: 3 });
    const every = await seedCommitment(db, person, goal, "Cada tanto", { kind: "every_n_days", n: 9 });
    for (const [id, label, value, sentence, kept] of [
      [week, "veces por semana", "8", WEEKS_BOUND, 3],
      [every, "cada cuántos días", "366", DAYS_BOUND, 9],
    ] as const) {
      const { page, context } = await visit(browser, baseURL, person, path(goal, id), 360);
      try {
        const posts = postCounter(page);
        await page.getByRole("spinbutton", { name: label }).fill(value);
        await page.getByRole("button", { name: /^Guardar/ }).click();
        await expect(page.getByText(sentence)).toBeVisible();
        expect(page.url()).toContain(path(goal, id));
        expect(posts).toHaveLength(0);
        expect((await rowsOf(db, id))[0].cadence_n).toBe(kept);
      } finally {
        await context.close();
      }
    }
  });

  test("a commitment with a fact, a retired one, an unknown one and another person's are not found, while a fact-less one opens", async ({ person, personId, browser, baseURL, db }) => {
    // Kills: rendering the page without reading `factDayCount`, `retiredAt` or the owner (the form opens on all of them).
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const open = await seedCommitment(db, person, goal, "Libre");
    const withFact = await seedCommitment(db, person, goal, "Con hecho");
    await seedFact(db, person.id, withFact, goal, shift(TODAY, -1), 15);
    const retired = await seedCommitment(db, person, goal, "Retirado");
    await db`update goals.commitments set retired_at = now() where id = ${retired}`;
    const [stranger] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon) values (${personId}, 'Ajena', null) returning id`;
    const [foreign] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${personId}, ${stranger.id}, 'Ajeno', 'daily', 'tap') returning id`;
    try {
      const control = await visit(browser, baseURL, person, path(goal, open), 360);
      try {
        await expect(chip(control.page, "todos los días")).toBeVisible();
      } finally {
        await control.context.close();
      }
      const cases = [
        path(goal, withFact),
        path(goal, retired),
        path(goal, "00000000-0000-4000-8000-000000000000"),
        path(goal, "xyz"),
        path(stranger.id, foreign.id),
        path(goal, foreign.id),
      ];
      for (const url of cases) {
        const { page, context } = await visit(browser, baseURL, person, url, 360);
        try {
          await expect(page.getByRole("heading", { name: "Esta página no existe" }), url).toBeVisible();
          await expect(chip(page, "días sueltos"), url).toHaveCount(0);
          await expect(page.getByText("Ajeno"), url).toHaveCount(0);
        } finally {
          await context.close();
        }
      }
    } finally {
      await db`delete from goals.goals where id = ${stranger.id} and user_id = ${personId}`;
    }
  });
});

test.describe("a loose habit's screen (RP-127, RP-135)", () => {
  const habitPath = (id: string) => `/metas/habitos/${id}`;

  test("without a fact it offers «Cambiar la frecuencia» and «Borrar el hábito» beside «Retirarlo»", async ({ person, browser, baseURL, db }) => {
    // Kills: hiding the offers on a fact-less habit.
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Borrar el hábito", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Cambiar la frecuencia", exact: true })).toHaveAttribute(
        "href",
        `${habitPath(id)}/frecuencia`,
      );
    } finally {
      await context.close();
    }
  });

  test("with a fact it offers neither", async ({ person, browser, baseURL, db }) => {
    // Kills: offering the delete or the cadence whatever `factDayCount` says.
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" });
    await seedFact(db, person.id, id, null, shift(TODAY, -1));
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Borrar el hábito" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Cambiar la frecuencia" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Cambiar la frecuencia" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("«Borrar el hábito» asks, then «Borrarlo» removes the habit and lands on /metas without it", async ({ person, browser, baseURL, db }) => {
    // Kills: hiding the delete on a count of 0; a delete that stays on the dead screen; a list that still draws the habit.
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      await page.getByRole("button", { name: "Borrar el hábito", exact: true }).click();
      await expect(page.getByText("Nadie lo ha hecho todavía: se borra sin dejar rastro. Retirarlo, en cambio, lo deja en «Retirados».")).toBeVisible();
      await page.getByRole("button", { name: "Borrarlo", exact: true }).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(await db`select id from goals.commitments where id = ${id}`).toHaveLength(0);
      expect(await mainLower(page)).not.toContain("meditar");
    } finally {
      await context.close();
    }
  });

  test("«Dejarlo como está» keeps the habit and sends nothing", async ({ person, browser, baseURL, db }) => {
    // Kills: a cancel that deletes.
    const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" });
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await mainLower(page);
      const posts = postCounter(page);
      await page.getByRole("button", { name: "Borrar el hábito", exact: true }).click();
      await page.getByRole("button", { name: "Dejarlo como está", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
      expect(await db`select id from goals.commitments where id = ${id}`).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});

test.describe("at 360 px (RP-127)", () => {
  test("the three-act sheet, the delete sheet and the cadence page do not scroll sideways", async ({ person, browser, baseURL, db }) => {
    // Kills: an act row or a field wider than the phone.
    const goal = await seedOpenGoal(db, person, { name: "Cuidado", unit: MINUTES, horizon: null });
    const id = await seedCommitment(db, person, goal, "Estirar un rato largo de nombre para que ocupe la línea entera", {
      kind: "weekdays",
      days: [1, 2, 3, 4, 5, 6, 7],
    });
    const wide = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
    try {
      const sheet = await openSheet(page, "Estirar un rato");
      await expect(sheet.getByRole("link", { name: "Cambiar la frecuencia", exact: true })).toBeVisible();
      expect(await wide(page)).toBeLessThanOrEqual(0);
      await sheet.getByRole("button", { name: "Borrar el compromiso", exact: true }).click();
      await expect(page.getByRole("button", { name: "Borrarlo", exact: true })).toBeVisible();
      expect(await wide(page)).toBeLessThanOrEqual(0);
      await page.goto(`/metas/${goal}/compromisos/${id}`);
      await settled(page);
      await expect(page.getByRole("button", { name: /^Guardar/ })).toBeVisible();
      expect(await wide(page)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
});

test("RP-104 sits in «Retired» with its tick and the line, and RP-135 is open where it was", () => {
  // Kills: an RP-104 left live beside its successor; RP-135 ticked or placed elsewhere.
  const spec = readFileSync(resolve(process.cwd(), "../../docs/pulsar/SPEC.md"), "utf8");
  const [live, retired] = spec.split(/^### Retired$/m);
  expect(retired).toBeDefined();
  expect(live).not.toMatch(/\*\*RP-104\*\*/);
  const line = retired.split("\n").find((l) => l.includes("**RP-104**"));
  expect(line).toMatch(/^- \[x\] \*\*RP-104\*\*/);
  expect(retired).toMatch(
    /Retired 2026-10-15 by the user: a loose habit no fact names changes its cadence \(RP-127\)\. Successor: \*\*RP-135\*\*\./,
  );
  const lines = live.split("\n");
  const at = lines.findIndex((l) => l.startsWith("- [x] **RP-113**"));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(lines[at + 1]).toMatch(/^- \[ \] \*\*RP-135\*\* \*\(successor of RP-104\)\*/);
  expect(lines[at + 1]).toContain("A retired habit is not edited.");
});
