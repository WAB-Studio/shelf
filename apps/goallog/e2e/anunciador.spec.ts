import { appAlerts, test, expect } from "./fixtures";

// Next's route announcer (`<next-route-announcer>`, open shadow root, `role="alert"`)
// holds the new title after a client navigation; `appAlerts` never counts it.

test("an alert count never counts Next's route announcer", async ({ page }) => {
  await page.goto("/hoy");
  const announcer = page.locator("next-route-announcer").getByRole("alert");
  // It mounts after hydration, and only later changes are announced.
  await expect(announcer).toBeAttached();
  await page.getByRole("link", { name: "Metas", exact: true }).first().dispatchEvent("click");
  await page.waitForURL(/\/metas$/);

  // Whether Next fills it with the title or an empty string depends on when its effect
  // reads the title, so the title is written the way Next writes it.
  await announcer.evaluate((node) => {
    node.textContent = "Metas · GoalLog";
  });
  await expect(announcer).toHaveText(/\S/);

  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(1);
  await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveCount(0);
});
