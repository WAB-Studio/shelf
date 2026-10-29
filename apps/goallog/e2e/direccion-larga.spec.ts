import type { Page } from "@playwright/test";

import { expect, test, visit } from "./fixtures";

// RP-136: the code step names the address the mail went to, and the address is one unbroken run that
// must not widen the page. The send is answered by hand (never a real one, RNP-09), so the form
// reaches the code step with the address as typed.

const LONG_ADDRESS = "unapersonaconuncorreomuylargoparaprobar@dominiola.co";

test("360: the code step holds a 52-character address whole, with no sideways scroll (RP-136)", async ({
  browser,
  baseURL,
}) => {
  // Kills: dropping `breakValue` from the code step's address, which lets the unbroken run widen the page.
  expect(LONG_ADDRESS).toHaveLength(52);
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 360, height: 740 },
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await answerSend(page);
    await visit(page, "/entrar");
    await page.getByLabel("Correo electrónico").fill(LONG_ADDRESS);
    await page.getByRole("button", { name: "Enviar código", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Revisa tu correo", exact: true })).toBeVisible();

    const sentence = page.locator("main").getByText(LONG_ADDRESS);
    await expect(sentence).toHaveCount(1);
    expect(((await sentence.textContent()) ?? "").trim()).toBe(LONG_ADDRESS);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

// The send action answered as sent; no request reaches Auth.
async function answerSend(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    const body = [
      '0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}',
      `1:${JSON.stringify({ ok: true })}`,
      "",
    ].join("\n");
    await route.fulfill({ status: 200, contentType: "text/x-component", body });
  });
}
