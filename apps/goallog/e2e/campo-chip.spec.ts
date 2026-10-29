import { test, expect, settled, visit } from "./fixtures";

// UX 303 and 307: a field's label is Archivo 13 in ink secondary, the hint keeps
// 20 px before the next control, and a selected chip is the soft accent fill,
// never the solid fill of the primary button.
test("a field label is Archivo 13 and a selected cadence chip is not the primary button's fill", async ({ page }) => {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(`Meta campo ${Date.now()}`);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  const goalUrl = page.url();

  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL("**/compromisos/nuevo");
  await settled(page);

  const label = await page.locator("label", { hasText: "qué es" }).evaluate((el) => {
    const style = getComputedStyle(el);
    return { family: style.fontFamily, size: style.fontSize, transform: style.textTransform };
  });
  expect(label.family).toMatch(/archivo/i);
  expect(label.family).not.toMatch(/mono/i);
  expect(label.size).toBe("13px");
  expect(label.transform).toBe("none");

  const chip = page.getByRole("button", { pressed: true }).first();
  const submit = page.getByRole("button", { name: "Añadirlo" });
  const [chipFill, buttonFill] = await Promise.all([
    chip.evaluate((el) => getComputedStyle(el).backgroundColor),
    submit.evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  expect(chipFill).not.toBe(buttonFill);
  // The selected chip wears the soft accent token itself.
  const soft = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--pulsar-accent-soft)";
    document.body.append(probe);
    const fill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return fill;
  });
  expect(chipFill).toBe(soft);

  // The hint, where a form has one, leaves 20 px before the next control.
  await visit(page, goalUrl.replace(/\/metas\/.*/, "/conexiones"));
  const gap = await page.evaluate(() => {
    const hint = [...document.querySelectorAll("span")].find((s) => /para reconocerla/i.test(s.textContent ?? ""));
    const next = hint?.closest("form, div")?.nextElementSibling ?? hint?.parentElement?.nextElementSibling;
    if (!hint || !next) return null;
    return next.getBoundingClientRect().top - hint.getBoundingClientRect().bottom;
  });
  expect(gap).not.toBeNull();
  expect(gap!).toBeGreaterThanOrEqual(20);
});

// A field's and a text area's label leave 8 px before their control.
test("a field label and a text area label hold 8 px before their control", async ({ page }) => {
  const gap = async (control: string) =>
    page.locator(control).first().evaluate((el) => {
      const label = (el as HTMLInputElement).labels![0];
      return el.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
    });
  await visit(page, "/metas/nueva");
  expect(await gap("input")).toBeGreaterThanOrEqual(8);
  expect(await gap("input")).toBeLessThan(10);
  await visit(page, "/metas/importar");
  expect(await gap("textarea")).toBeGreaterThanOrEqual(8);
  expect(await gap("textarea")).toBeLessThan(10);
});
