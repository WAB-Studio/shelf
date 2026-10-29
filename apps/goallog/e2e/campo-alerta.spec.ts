import { randomUUID } from "node:crypto";

import { invite } from "./entrar-invitado";
import { test, expect } from "./fixtures";
import { seedHabit } from "./sin-final-seed";
import { visit } from "./metas-sin-final-seed";

// A field's refusal is announced (WCAG 3.3.1, 3.3.2): it mounts as an alert tied to the control by
// `aria-describedby`, while a hint that is not refused stays a plain sentence. Words are literals,
// not read from messages/es, so the spec cannot agree with whatever the messages say.

const NAME_REFUSED = "Escribe un nombre.";
const WEEKS_REFUSED = "Escribe un número entero de semanas, entre 1 y 520.";
const WEEKS_HINT = "cuántas semanas le das. Se puede mover después.";
const NOTE_REFUSED = "La nota pasa de 2 000 caracteres.";
const CODE_SHORT = "Escribe los seis números del correo.";

test.describe("Field", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("a refused name is an alert the textbox's description names; the unrefused hint beside it is not", async ({ page }) => {
    // Kills: the refusal as a plain span (no alert); the alert on every hint; a describedby that misses the refusal.
    await page.goto("/metas/nueva");
    const main = page.locator("main");
    const name = page.getByLabel("nombre");
    const weeks = page.getByLabel("final");

    // Before any refusal: a hint, not an alert, and the field is described by it.
    await expect(main.getByText(WEEKS_HINT)).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(weeks).toHaveAccessibleDescription(WEEKS_HINT);
    await expect(name).not.toHaveAttribute("aria-describedby", /.+/);

    await page.getByRole("button", { name: "Abrirla" }).click();
    await expect(main.getByRole("alert")).toHaveText(NAME_REFUSED);
    await expect(name).toHaveAccessibleDescription(NAME_REFUSED);
    await expect(weeks).toHaveAccessibleDescription(WEEKS_HINT);
    await expect(main.getByRole("alert")).toHaveCount(1);
  });

  test("a hint that becomes a refusal turns into an alert in its place", async ({ page }) => {
    // Kills: an alert that only mounts at first render, so a later refusal is never announced.
    await page.goto("/metas/nueva");
    const main = page.locator("main");
    const weeks = page.getByLabel("final");
    await page.getByLabel("nombre").fill(`Meta alerta ${randomUUID().slice(0, 8)}`);
    await weeks.fill("9999");
    await page.getByRole("button", { name: "Abrirla" }).click();

    await expect(main.getByRole("alert")).toHaveText(WEEKS_REFUSED);
    await expect(weeks).toHaveAccessibleDescription(WEEKS_REFUSED);
    await expect(main.getByText(WEEKS_HINT)).toHaveCount(0);
  });

  test("typing in a refused field clears its alert", async ({ browser, baseURL, db }) => {
    // Kills: an alert left mounted after the person starts correcting the value.
    const email = `harness-inv-${randomUUID().slice(0, 6)}@gmail.com`;
    await invite(db, email);
    const context = await browser.newContext({
      baseURL: baseURL!,
      storageState: { cookies: [], origins: [] },
      viewport: { width: 360, height: 740 },
      extraHTTPHeaders: { "x-forwarded-for": `2001:db8:${randomUUID().slice(0, 4)}::7` },
    });
    try {
      const page = await context.newPage();
      await page.goto("/entrar");
      await page.getByLabel("Correo electrónico").fill(email);
      await page.getByRole("button", { name: "Enviar código", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Revisa tu correo", exact: true })).toBeVisible();

      const code = page.getByLabel("Código del correo");
      await code.fill("12345");
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      const alert = page.getByRole("alert").filter({ hasText: CODE_SHORT });
      await expect(alert).toHaveCount(1);
      await expect(code).toHaveAccessibleDescription(CODE_SHORT);

      await code.pressSequentially("6");
      await expect(alert).toHaveCount(0);
      await expect(code).not.toHaveAttribute("aria-invalid", "true");
    } finally {
      await context.close();
      await db`delete from goals.allowed_emails where email = ${email.toLowerCase()}`;
    }
  });
});

test.describe("TextArea", () => {
  test("a refused note is an alert the textarea's description names", async ({ person, browser, baseURL, db }) => {
    // Kills: the area's refusal as a plain span, or a describedby that does not name it.
    const id = await seedHabit(db, person.id, "Meditar alerta", { kind: "daily" });
    const { page, context } = await visit(browser, baseURL, person, `/metas/habitos/${id}`, 360);
    try {
      await page.getByRole("button", { name: "Editar", exact: true }).click();
      const sheet = page.getByRole("dialog");
      const note = sheet.getByLabel("nota, si quieres", { exact: true });
      await expect(sheet.getByRole("alert")).toHaveCount(0);
      await note.fill("a".repeat(2001));
      await sheet.getByRole("button", { name: "Guardarlo", exact: true }).click();
      await expect(sheet.getByRole("alert")).toHaveText(NOTE_REFUSED);
      await expect(note).toHaveAccessibleDescription(NOTE_REFUSED);
      await expect(note).toHaveAttribute("aria-invalid", "true");
    } finally {
      await context.close();
    }
  });
});
