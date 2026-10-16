import { test, expect } from "./fixtures";
import { civilDateShort, todayInZone } from "@/lib/zone";

// RNP-17: every signed-in screen stands in the desktop frame — the rail's
// name, its four entries, today's date and the face toggle at its foot.
const PLACES = /^(Hoy|Semana|Mes|Metas)$/;
const ROUTES = [
  ["/", "Hoy"],
  ["/semana", "Semana"],
  ["/metas", "Metas"],
  ["/sueltas", "Hoy"],
] as const;

for (const [path, marked] of ROUTES) {
  test(`at 1280 ${path} stands in the rail and marks ${marked}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(path);

    const rail = page.getByRole("navigation");
    await expect(rail).toContainText("GoalLog");
    // The four places; the goals the rail names after them are `pestanas.spec.ts`'s.
    await expect(rail.getByRole("link").filter({ hasText: PLACES })).toHaveCount(4);
    await expect(rail).toContainText(civilDateShort(todayInZone()));
    await expect(rail.getByRole("button")).toHaveCount(1);

    const current = rail.locator("a[aria-current='page']");
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(marked);
  });
}

test("at 1280 the rail's toggle switches the face and the choice survives a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/semana");

  await page.getByRole("navigation").getByRole("button", { name: "Cambiar a modo oscuro" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(
    page.getByRole("navigation").getByRole("button", { name: "Cambiar a modo claro" }),
  ).toBeVisible();
});

test("at 360 the bottom nav is four tabs with no name, date or toggle", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/semana");

  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link")).toHaveCount(4);
  await expect(nav.getByText("GoalLog")).toBeHidden();
  await expect(nav.getByText(civilDateShort(todayInZone()))).toBeHidden();
  await expect(nav.getByRole("button")).toBeHidden();
  await expect(nav.getByRole("link", { name: "Metas", exact: true })).toBeVisible();
});
