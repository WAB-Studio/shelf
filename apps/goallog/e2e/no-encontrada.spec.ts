import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `ArmazonNoEncontrada.dc.html` (RNP-01, RNP-16): inside the app the layout's nav is the
// only one, and outside it the not-found draws its own, once.
const UNKNOWN_GOAL = "00000000-0000-4000-8000-000000000000";

for (const path of ["/dia/zzz", `/metas/${UNKNOWN_GOAL}`, "/metas/xyz", "/nada"]) {
  test(`${path} says the page does not exist and draws one navigation`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(1);
    // 318: the header's one line is the title; «no está» over it said the same twice.
    await expect(page.locator("main > header > div")).toHaveCount(1);
    await expect(page.getByText("Si era una meta, puede que esté archivada")).toBeVisible();
    await expect(page.getByRole("link", { name: "Ir a hoy" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Volver a / })).toHaveCount(0);
  });
}

for (const width of [360, 1280]) {
  for (const path of ["/dia/zzz", `/metas/${UNKNOWN_GOAL}`, "/no-existe"]) {
    test(`at ${width} ${path} marks no tab`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
      await expect(
        page.getByRole("navigation").getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ }),
      ).toHaveCount(4);
      await expect(page.locator("a[aria-current]")).toHaveCount(0);
    });
  }
}

test("a real past day still marks Semana", async ({ page }) => {
  const yesterday = civilDateToDate(todayInZone());
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  await page.goto(`/dia/${dateToCivilDate(yesterday)}`);
  await expect(page.getByRole("link", { name: "Semana" })).toHaveAttribute("aria-current", "page");
});
