import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { dialog, mainLower, visit } from "./metas-sin-final-seed";
import { seedGoal, seedHabit } from "./sin-final-seed";
import { boxOf } from "./box";

// Module 933, RP-109: a retired habit is reached again from `/metas`, in a folded «Retirados» group under
// «Hábitos», above «Añadir un hábito». Boards: HabitosRetirados (private/tableros-s3/NOTAS.md §4), E5 of
// private/contrato-933.md. Written from the contract before `retired-habits.tsx` exists. Every test names the
// mutation that kills it.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const CREATED = noonOf("2026-08-01");
const WIDTHS = [360, 1280];

// E5: live «Tomar agua», «Estirar», «Llamar a mamá»; retired «Leer antes de dormir» (2 oct 2026), «Meditar» (20 sep 2026).
async function e5(db: import("./meta-arbol-seed").Db, personId: string) {
  await seedHabit(db, personId, "Tomar agua", { kind: "daily" }, { kind: "tap" }, { created: CREATED });
  await seedHabit(db, personId, "Estirar", { kind: "weekdays", days: [1, 3, 5] }, { kind: "tap" }, { created: CREATED });
  await seedHabit(db, personId, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: CREATED });
  const reading = await seedHabit(db, personId, "Leer antes de dormir", { kind: "daily" }, { kind: "tap" }, { created: CREATED, retired: noonOf("2026-10-02") });
  const meditate = await seedHabit(db, personId, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: noonOf("2026-07-05"), retired: noonOf("2026-09-20") });
  return { reading, meditate };
}

const group = (page: Page) => page.getByRole("button", { name: /^(Desplegar|Plegar) Retirados$/ }).locator("visible=true");

for (const width of WIDTHS) {
  test.describe(`at ${width}`, () => {
    test("folded by default: «Retirados» with «2» sits after the last live habit and above «Añadir un hábito»; no retired name is shown (RP-109)", async ({ person, browser, baseURL, db }) => {
      // Kills: unfolded by default; the group drawn under «Añadir un hábito»; a count that includes a goal's retired commitment.
      await e5(db, person.id);
      const goal = await seedGoal(db, person.id, "Cuidado", { horizon: null });
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, retired_at)
        values (${person.id}, ${goal}, 'Retirado de meta', 'daily', 'tap', now())`;
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        const text = await mainLower(page);
        const button = group(page);
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAttribute("aria-expanded", "false");
        await expect(button).toHaveAccessibleName("Desplegar Retirados");
        await expect(button).toContainText("Retirados");
        await expect(button).toContainText("2");
        const at = text.indexOf("retirados");
        expect(at).toBeGreaterThan(text.indexOf("llamar a mamá"));
        expect(at).toBeGreaterThan(text.indexOf("estirar"));
        expect(at).toBeLessThan(text.indexOf("añadir un hábito"));
        await expect(page.getByText("Leer antes de dormir")).toHaveCount(0);
        await expect(page.getByText("Meditar")).toHaveCount(0);
        expect(text).not.toContain("retirado el");
      } finally {
        await context.close();
      }
    });

    test("tapping the whole row unfolds it: «Plegar Retirados», latest first, each with «retirado el {fecha}», indented as a child, linked to its screen (RP-109)", async ({ person, browser, baseURL, db }) => {
      // Kills: a row that does not open; the retired shown in the live order; no indent (level 0); a row without its date or `href`.
      const { reading, meditate } = await e5(db, person.id);
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await mainLower(page);
        await group(page).click();
        await expect(group(page)).toHaveAttribute("aria-expanded", "true");
        await expect(group(page)).toHaveAccessibleName("Plegar Retirados");
        const text = await mainLower(page);
        const first = text.search(/leer antes de dormir\s*·?\s*retirado el 2 oct 2026/);
        const second = text.search(/meditar\s*·?\s*retirado el 20 sep 2026/);
        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
        await expect(page.locator(`main a[href="/metas/habitos/${reading}"]:visible`)).toHaveCount(1);
        await expect(page.locator(`main a[href="/metas/habitos/${meditate}"]:visible`)).toHaveCount(1);
        const live = (await boxOf(page.locator('main a:visible', { hasText: "Llamar a mamá" }).first().getByText("Llamar a mamá")));
        const child = (await boxOf(page.locator(`main a[href="/metas/habitos/${meditate}"]:visible`).getByText("Meditar")));
        expect(child.x).toBeGreaterThan(live.x + 8);
      } finally {
        await context.close();
      }
    });

    test("the retired are ordered by the day they were retired, latest first: neither by name nor by when they were made (RP-109)", async ({ person, browser, baseURL, db }) => {
      // Kills: ordering by name, by retiredAt ascending, or leaving the loader's order. Names sort against the dates on purpose.
      await seedHabit(db, person.id, "Leer", { kind: "daily" }, { kind: "tap" }, { created: CREATED, retired: noonOf("2026-10-02") });
      await seedHabit(db, person.id, "Zumba", { kind: "daily" }, { kind: "tap" }, { created: CREATED, retired: noonOf("2026-10-10") });
      await seedHabit(db, person.id, "Aprender", { kind: "daily" }, { kind: "tap" }, { created: CREATED, retired: noonOf("2026-09-20") });
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await mainLower(page);
        await group(page).click();
        const text = await mainLower(page);
        const order = ["zumba", "leer", "aprender"].map((name) => text.indexOf(name, text.indexOf("retirados")));
        expect(order[0]).toBeGreaterThan(-1);
        expect(order[1]).toBeGreaterThan(order[0]);
        expect(order[2]).toBeGreaterThan(order[1]);
      } finally {
        await context.close();
      }
    });

    test("a second tap folds it again, and reloading folds it (the fold is kept nowhere) (RP-109)", async ({ person, browser, baseURL, db }) => {
      // Kills: a toggle that only opens; a fold kept in storage or the URL.
      await e5(db, person.id);
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        await mainLower(page);
        await group(page).click();
        await expect(group(page)).toHaveAttribute("aria-expanded", "true");
        await group(page).click();
        await expect(group(page)).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("Meditar")).toHaveCount(0);
        await group(page).click();
        await expect(page.getByText("Meditar")).toBeVisible();
        await page.reload();
        await mainLower(page);
        await expect(group(page)).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("Meditar")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("with no retired habit there is no group and no «0» (RP-109)", async ({ person, browser, baseURL, db }) => {
      // Kills: a group drawn always.
      await seedHabit(db, person.id, "Tomar agua", { kind: "daily" }, { kind: "tap" }, { created: CREATED });
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        const text = await mainLower(page);
        expect(text).toContain("tomar agua");
        expect(text).not.toContain("retirados");
        await expect(page.getByRole("button", { name: /Retirados/ })).toHaveCount(0);
        expect(between0(text)).not.toMatch(/\b0\b/);
      } finally {
        await context.close();
      }
    });

    test("only retired habits: «Ninguno todavía.» and, after it and before «Añadir un hábito», the group (RP-109)", async ({ person, browser, baseURL, db }) => {
      // Kills: hiding the group when no habit is alive; «Ninguno todavía.» dropped because retired ones exist.
      await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: CREATED, retired: noonOf("2026-09-20") });
      const { page, context } = await visit(browser, baseURL, person, "/metas", width);
      try {
        const text = await mainLower(page);
        expect(text).toContain("ninguno todavía.");
        await expect(group(page)).toHaveCount(1);
        await expect(group(page)).toContainText("1");
        expect(text.indexOf("retirados")).toBeGreaterThan(text.indexOf("ninguno todavía."));
        expect(text.indexOf("retirados")).toBeLessThan(text.indexOf("añadir un hábito"));
      } finally {
        await context.close();
      }
    });
  });
}

// The page's text without its date line, so a stray «0» is a count and not a day of the month.
const between0 = (text: string) => text.replace(/\d{1,2} de [a-záéíóú]+ de \d{4}/g, "").replace(/\d{1,2}:\d{2}/g, "");

test.describe("opening and retiring", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("«Meditar» in «Retirados» opens its screen: «retirado el 20 sep 2026», and neither «Editar», «Retirarlo» nor «volver a pedirlo» (RP-109)", async ({ person, browser, baseURL, db }) => {
    // Kills: a row with no `href`; a retired screen that offers the buttons or a way back.
    const { meditate } = await e5(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/metas", 360);
    try {
      await mainLower(page);
      await group(page).click();
      await page.getByText("Meditar", { exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/habitos/${meditate}$`));
      const text = await mainLower(page);
      await expect(page.getByRole("heading", { level: 1, name: "Meditar" })).toBeVisible();
      expect(text).toContain("retirado el 20 sep 2026");
      await expect(page.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toHaveCount(0);
      expect(text).not.toContain("volver a pedirlo");
      await expect(page.getByRole("button", { name: /volver a pedirlo/i })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("«Retirarlo» from the habit's screen, then back on `/metas`: out of the live ones, inside the group (RP-109)", async ({ person, browser, baseURL, db }) => {
    // Kills: a loader that keeps `retiredAt === null` for everything; a group fed only on a reload of the server.
    const id = await seedHabit(db, person.id, "Tomar agua", { kind: "daily" }, { kind: "tap" }, { created: CREATED });
    await seedHabit(db, person.id, "Estirar", { kind: "daily" }, { kind: "tap" }, { created: CREATED });
    const { page, context } = await visit(browser, baseURL, person, "/metas", 360);
    try {
      await mainLower(page);
      await expect(group(page)).toHaveCount(0);
      await page.getByText("Tomar agua", { exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/habitos/${id}$`));
      await page.getByRole("button", { name: "Retirarlo", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Retirarlo", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await page.goto("/metas");
      await mainLower(page);
      await expect(page.getByText("Tomar agua", { exact: true })).toHaveCount(0);
      await expect(group(page)).toHaveCount(1);
      await expect(group(page)).toContainText("1");
      await group(page).click();
      await expect(page.locator(`main a[href="/metas/habitos/${id}"]:visible`)).toHaveCount(1);
      const text = await mainLower(page);
      expect(text.indexOf("estirar")).toBeLessThan(text.indexOf("retirados"));
      expect(text.indexOf("tomar agua")).toBeGreaterThan(text.indexOf("retirados"));
    } finally {
      await context.close();
    }
  });

  test("at 360 the unfolded group overflows nothing and every control is 32 px or more (RNP-07)", async ({ person, browser, baseURL, db }) => {
    // Kills: a group row with a long name that is not allowed to wrap (`narrow` missing); a tap target under 32 px.
    await e5(db, person.id);
    await seedHabit(db, person.id, "Leer cada noche, sin pantallas, un capítulo del libro que dejé a la mitad", { kind: "daily" }, { kind: "tap" }, {
      created: CREATED,
      retired: noonOf("2026-10-05"),
    });
    const { page, context } = await visit(browser, baseURL, person, "/metas", 360);
    try {
      await mainLower(page);
      await group(page).click();
      await expect(page.getByText("Meditar")).toBeVisible();
      const report = await page.evaluate(() => {
        const bad: string[] = [];
        if (document.documentElement.scrollWidth > 360) bad.push(`scrollWidth ${document.documentElement.scrollWidth}`);
        for (const el of Array.from(document.querySelectorAll('main a[href], main button, main [role="button"]'))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (Math.min(r.width, r.height) < 32) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} ${r.width}x${r.height}`);
          if (r.right > 360.5) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} right ${r.right}`);
        }
        return bad;
      });
      expect(report).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
