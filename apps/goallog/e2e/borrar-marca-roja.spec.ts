import { test, expect } from "./fixtures";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";

// A destructive act is ink with a red mark, never red text (docs/goallog/DESIGN.md «Button hierarchy»).
test("«Borrar la meta» keeps its label in ink and carries a red mark", async ({ person, browser, baseURL, db }) => {
  const id = await seedOpenGoal(db, person, { name: "Marca roja", unit: null });
  const { page, context } = await visit(browser, baseURL, person, `/metas/${id}`, 1280);
  try {
    const button = page.getByRole("button", { name: "Borrar la meta" }).locator("visible=true").first();
    await expect(button).toBeVisible();
    const style = await button.evaluate((el) => ({
      text: getComputedStyle(el).color,
      mark: getComputedStyle(el, "::before").backgroundColor,
    }));
    expect(style.text, "the label is not the danger red").not.toBe("rgb(180, 35, 24)");
    expect(style.text, "the mark is not the label's colour").not.toBe(style.mark);
    expect(style.mark, "the mark is drawn").not.toBe("rgba(0, 0, 0, 0)");
  } finally {
    await context.close();
  }
});
