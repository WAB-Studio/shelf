import { test, expect } from "./fixtures";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";
import { todayInZone } from "@/lib/zone";

// The Mes calendar (decided 2026-10-31): every day up to today opens that day, a day still to come is plain,
// and a legend says what a shade means.
const TODAY = todayInZone();

test("the calendar's days up to today are links that open the day; the legend names the shades", async ({ person, browser, baseURL, db }) => {
  await seedOpenGoal(db, person, { name: "Calendario", unit: { measure: "minutos", unit: "minutos" } });
  const { page, context } = await visit(browser, baseURL, person, "/mes", 390);
  try {
    const grid = page.locator('[data-part="month-grid"]');
    await expect(grid).toBeVisible();
    const days = grid.locator("a[data-day]");
    const first = `${TODAY.slice(0, 7)}-01`;
    await expect(days).toHaveCount(Number(TODAY.slice(8, 10)));
    await expect(grid.locator(`a[data-day="${first}"]`)).toHaveAttribute("href", first === TODAY ? "/" : `/dia/${first}`);
    await expect(grid.locator(`a[data-day="${TODAY}"]`)).toHaveAttribute("href", "/");
    // Nothing after today is a link.
    const lastDay = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 0)).getUTCDate();
    if (Number(TODAY.slice(8, 10)) < lastDay) {
      await expect(grid.locator("span[role=img]").last()).toBeVisible();
    }
    await expect(page.locator('[data-part="month-legend"]')).toContainText("menos");
    await expect(page.locator('[data-part="month-legend"]')).toContainText("más");
    await expect(page.getByText("Toca un día para abrirlo.", { exact: false })).toBeVisible();
    const box = (await days.first().boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    if (first !== TODAY) {
      await days.first().click();
      await expect(page).toHaveURL(new RegExp(`/dia/${first}$`));
    }
  } finally {
    await context.close();
  }
});

// From the 25th the card also offers the next month; before it, only what the month lacks.
test("from the 25th «Planear <mes siguiente>» sits beside the month's own; before it never", async ({ person, browser, baseURL, db }) => {
  await seedOpenGoal(db, person, { name: "Siguiente", unit: { measure: "minutos", unit: "minutos" } });
  const { page, context } = await visit(browser, baseURL, person, "/mes", 390);
  try {
    const next = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 1));
    const name = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(next);
    const link = page.getByRole("link", { name: `Planear ${name}`, exact: true });
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    if (Number(TODAY.slice(8, 10)) >= 25) {
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("href", new RegExp(`planear=${next.toISOString().slice(0, 7)}`));
    } else {
      await expect(link).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});
