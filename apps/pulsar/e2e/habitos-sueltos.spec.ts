import plan from "../messages/es/plan.json";
import { test, expect } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import {
  MINUTES,
  between,
  countCommitments,
  dialog,
  habitRows,
  mainLower,
  postCounter,
  seedHabit,
  seedOpenGoal,
  visit,
} from "./sin-final-seed";

// A locator that never appears fails in 6 s with its own name, never as the test's 30 s timeout.
test.use({ actionTimeout: 6000 });

// Module 916, RP-100: a commitment that belongs to no goal — a loose habit — is listed, created and
// retired in its own section of `/metas`, «Hábitos» (the user's decision of 2026-10-13: never «Sin
// meta»). Board: HabitosSueltos (private/tableros-sin-final/NOTAS.md §12). Every test names the
// mutation that kills it.

const SECTION = "hábitos";

async function twoHabits(db: import("./meta-arbol-seed").Db, person: import("./fixtures").Person) {
  await seedHabit(db, person, { name: "Tomar agua", quantity: 2, unit: "litros", note: "Un vaso al despertar y otro antes de cada comida." });
  await seedHabit(db, person, { name: "Estirar", cadence: "weekdays", weekdays: [1, 3, 5], quantity: 10, unit: "min" });
  await seedHabit(db, person, { name: "Llamar a mamá", cadence: "times_per_week", n: 1, note: "Los domingos, después de almorzar." });
}

for (const width of [360, 1280]) {
  test.describe(`at ${width}`, () => {
    test("with no habit the section is there, says «Ninguno todavía.» and offers «Agregar un hábito» (RP-100)", async ({ person, browser, baseURL, db }) => {
      // Kills: hiding the section while it is empty (the person cannot reach the form).
      await seedOpenGoal(db, person, { name: "Cuidado personal", unit: MINUTES, horizon: null });
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        const text = await mainLower(page);
        expect(text).toContain(SECTION);
        expect(text).toContain("ninguno todavía.");
        await expect(page.getByRole("link", { name: "Agregar un hábito", exact: true }).or(page.getByRole("button", { name: "Agregar un hábito", exact: true }))).toBeVisible();
        expect(text).not.toContain("sin meta");
        // Under the open goals, not above them.
        expect(text.indexOf(SECTION)).toBeGreaterThan(text.indexOf("cuidado personal"));
      } finally {
        await context.close();
      }
    });

    test("the section lists each loose habit with its cadence and its note, and only those: never a goal's commitment, never a retired one (RP-100)", async ({ person, browser, baseURL, db }) => {
      // Kills: a list that includes a goal's commitments or retired habits; a row that drops the note or the amount.
      await twoHabits(db, person);
      await seedHabit(db, person, { name: "Hábito retirado", retired: true });
      const goal = await seedOpenGoal(db, person, { name: "Cuidado personal", unit: MINUTES, horizon: null });
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${person.id}, ${goal}, 'Bañarse', 'daily', 'tap')`;
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await expect(page.getByText("Tomar agua", { exact: true })).toBeVisible();
        const text = await mainLower(page);
        const section = between(text, SECTION);
        expect(section).toContain("tomar agua todos los días · 2 litros un vaso al despertar y otro antes de cada comida.");
        expect(section).toContain("estirar lun, mié y vie · 10 min");
        expect(section).toContain("llamar a mamá 1 vez por semana los domingos, después de almorzar.");
        expect(section).not.toContain("estirar lun, mié y vie · 10 min un vaso");
        expect(section).not.toContain("bañarse");
        expect(section).not.toContain("retirado");
        expect(section).not.toContain("ninguno todavía");
        expect(text.indexOf(SECTION)).toBeGreaterThan(text.indexOf("cuidado personal"));
        expect(text).not.toContain("sin meta");
      } finally {
        await context.close();
      }
    });

    test("«Agregar un hábito» opens «Hábito nuevo» with the fields of the board and no external source (RP-100)", async ({ person, browser, baseURL }) => {
      // Kills: a route that needs a `goalId`; offering «lo que anota otra app» to a habit that has no source.
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await page.getByRole("link", { name: "Agregar un hábito", exact: true }).or(page.getByRole("button", { name: "Agregar un hábito", exact: true })).click();
        await expect(page).toHaveURL(/\/metas\/habitos\/nuevo$/);
        await expect(page.getByRole("heading", { level: 1, name: "Hábito nuevo" })).toBeVisible();
        await expect(page.getByLabel("qué es", { exact: true })).toBeVisible();
        await expect(page.getByLabel("nota, si quieres")).toBeVisible();
        const text = await mainLower(page);
        for (const part of ["cada cuándo", "qué lo da por hecho", "una vez", "un número"]) expect(text).toContain(part);
        expect(text).not.toContain("lo que anota otra app");
        await expect(page.getByRole("link", { name: /Metas/ }).first()).toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
}

// The form is one page, drawn at 360 (HabitosSueltos-3 to -5).
test.describe("the habit form", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("«Añadirlo» writes a habit of no goal with its note, and lands on `/metas` with it listed (RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: writing the habit under a goal id; dropping the note; not revalidating the list.
    const { page, context } = await visit(browser, baseURL, person, "/metas/habitos/nuevo", 360);
    try {
      await page.getByLabel("qué es", { exact: true }).fill("Bañarse");
      await page.getByLabel("nota, si quieres").fill("Con agua fría.");
      await page.getByRole("button", { name: "Añadirlo", exact: true }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await habitRows(db, person, "Bañarse");
      expect(rows).toHaveLength(1);
      expect(rows[0].goal_id).toBeNull();
      expect(rows[0].note).toBe("Con agua fría.");
      expect(rows[0].cadence_kind).toBe("daily");
      const section = between(await mainLower(page), SECTION);
      expect(section).toContain("bañarse todos los días con agua fría.");
    } finally {
      await context.close();
    }
  });

  test("a habit without a note is written with no note at all (RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: storing an empty string for an absent note (the CHECK would refuse it, or a blank row would draw).
    const { page, context } = await visit(browser, baseURL, person, "/metas/habitos/nuevo", 360);
    try {
      await page.getByLabel("qué es", { exact: true }).fill("Estirar");
      await page.getByRole("button", { name: "Añadirlo", exact: true }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await habitRows(db, person, "Estirar");
      expect(rows).toHaveLength(1);
      expect(rows[0].note).toBeNull();
      expect(rows[0].goal_id).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("9 times a week is refused under its field with the sentence of the cap, and nothing is written (RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: a form that sends what the schema refuses; a sentence away from its field.
    const { page, context } = await visit(browser, baseURL, person, "/metas/habitos/nuevo", 360);
    try {
      await page.getByLabel("qué es", { exact: true }).fill("Correr");
      await page.getByRole("radio", { name: /veces por semana/ }).or(page.getByRole("button", { name: /veces por semana/ })).first().click();
      await page.getByLabel("veces por semana", { exact: true }).fill("9");
      await page.getByRole("button", { name: "Añadirlo", exact: true }).click();
      await expect(page.getByText(plan.errors.timesPerWeekInvalid, { exact: true })).toBeVisible();
      await expect(page.getByLabel("veces por semana", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await expect(page).toHaveURL(/\/metas\/habitos\/nuevo$/);
      expect(await countCommitments(db, person)).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("an empty name is refused with «Escribe un nombre.» and nothing is written (RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: a submit that swallows the refusal.
    const { page, context } = await visit(browser, baseURL, person, "/metas/habitos/nuevo", 360);
    try {
      await page.getByRole("button", { name: "Añadirlo", exact: true }).click();
      await expect(page.getByText(plan.errors.nameEmpty, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/metas\/habitos\/nuevo$/);
      expect(await countCommitments(db, person)).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("«Añadirlo» pends as «Añadiéndolo…», disabled, so a second tap writes no second habit (RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: a button with no pending state.
    const { page, context } = await visit(browser, baseURL, person, "/metas/habitos/nuevo", 360);
    try {
      await holdActions(page, 1500);
      await page.getByLabel("qué es", { exact: true }).fill("Meditar");
      await page.getByRole("button", { name: "Añadirlo", exact: true }).click();
      const pending = page.getByRole("button", { name: "Añadiéndolo…", exact: true });
      await expect(pending).toBeVisible();
      await expect(pending).toBeDisabled();
      await expect(page).toHaveURL(/\/metas$/);
      expect(await habitRows(db, person, "Meditar")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("leaving by «‹ Metas» writes nothing and shows the list as it was (RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: a form that writes on mount or on leaving.
    const { page, context } = await visit(browser, baseURL, person, "/metas/habitos/nuevo", 360);
    try {
      const posts = postCounter(page);
      await page.getByLabel("qué es", { exact: true }).fill("No lo escribas");
      await page.getByRole("link", { name: /Metas/ }).first().click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(posts).toEqual([]);
      expect(await countCommitments(db, person)).toBe(0);
      expect(await mainLower(page)).toContain("ninguno todavía.");
    } finally {
      await context.close();
    }
  });
});

test.describe("retiring a habit", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("tapping its name asks «¿Retirarlo?» with the days it was done; «Dejarlo como está» keeps it (RP-13, RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: a name that opens nothing; a cancel that retires.
    const id = await seedHabit(db, person, { name: "Tomar agua", quantity: 2, unit: "litros" });
    for (let d = 1; d <= 12; d += 1) {
      await db`
        insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
        values (${person.id}, ${id}, null, (now() at time zone 'America/Bogota')::date - ${d}::int, 2)`;
    }
    const { page, context } = await visit(browser, baseURL, person, "/metas", 360);
    try {
      const posts = postCounter(page);
      await page.getByText("Tomar agua", { exact: true }).click();
      const sheet = dialog(page);
      await expect(sheet.getByRole("heading", { name: "¿Retirarlo?" })).toBeVisible();
      await expect(
        sheet.getByText("Deja de pedirse desde mañana. Las semanas que ya gobernó siguen leyéndose igual, y los 12 días en que lo hiciste siguen ahí.", { exact: true }),
      ).toBeVisible();
      await sheet.getByRole("button", { name: "Dejarlo como está", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(posts).toEqual([]);
      expect((await habitRows(db, person, "Tomar agua"))[0].retired_at).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("«Retirarlo» takes it out of the section and out of Hoy, and keeps the row and its days (RP-13, RP-100)", async ({ person, browser, baseURL, db }) => {
    // Kills: deleting the row instead of retiring it; a retired habit still listed.
    const id = await seedHabit(db, person, { name: "Tomar agua", quantity: 2, unit: "litros" });
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${id}, null, (now() at time zone 'America/Bogota')::date - 1, 2)`;
    const { page, context } = await visit(browser, baseURL, person, "/", 360);
    try {
      await expect(page.getByText("Tomar agua").first()).toBeVisible();
      await page.goto("/metas");
      await page.getByText("Tomar agua", { exact: true }).click();
      await dialog(page).getByRole("button", { name: "Retirarlo", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByText("Tomar agua", { exact: true })).toHaveCount(0);
      expect(await mainLower(page)).toContain("ninguno todavía.");
      const rows = await habitRows(db, person, "Tomar agua");
      expect(rows).toHaveLength(1);
      expect(rows[0].retired_at).not.toBeNull();
      const [{ n }] = await db<{ n: string }[]>`select count(*)::text as n from goals.facts where commitment_id = ${id}`;
      expect(Number(n)).toBe(1);
      await page.goto("/");
      await expect(page.getByText("Tomar agua", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
