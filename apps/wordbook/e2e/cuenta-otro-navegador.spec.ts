import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// RL-69 (PKCE): a link only enters the browser that asked for it. The
// words are the approved board's (CuentaEnlaceOtroNavegador), written out
// here so the test does not agree with whatever the message file holds.
const OTHER_BROWSER_TITLE = "Abre el enlace en el navegador donde lo pediste";
const OTHER_BROWSER_BODY =
  "Por seguridad el enlace solo entra en el navegador que lo pidió. Pide uno nuevo aquí abajo si cambiaste.";

test("RL-69: ?error=linkOtherBrowser draws its own notice, and neither of RL-49's", async ({ page }) => {
  await page.goto("/cuenta?error=linkOtherBrowser");

  await expect(page.getByText(OTHER_BROWSER_TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText(OTHER_BROWSER_BODY, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.account.errors.linkInvalidTitle)).toHaveCount(0);
  await expect(page.getByText(messages.account.errors.linkTimeoutTitle)).toHaveCount(0);
  // No button of its own: the form below is the retry.
  await expect(page.getByRole("textbox", { name: messages.account.emailLabel })).toBeVisible();
});

test("an unknown ?error value draws no notice at all", async ({ page }) => {
  await page.goto("/cuenta?error=bogus");

  await expect(page.getByRole("textbox", { name: messages.account.emailLabel })).toBeVisible();
  for (const text of [
    OTHER_BROWSER_TITLE,
    messages.account.errors.linkInvalidTitle,
    messages.account.errors.linkTimeoutTitle,
  ]) {
    await expect(page.getByText(text)).toHaveCount(0);
  }
});
