import messages from "../messages/es.json";
import { expect, test } from "./fixtures";

// RL-49: what `?error=` and `?tab=` do to the failure notice on /cuenta.

const errors = messages.account.errors;

test("RL-49: ?tab=info&error=linkInvalid paints no notice over Información", async ({ page }) => {
  await page.goto("/cuenta?tab=info&error=linkInvalid");

  await expect(page.getByText(messages.account.info.licenceName)).toBeVisible();
  await expect(page.getByText(errors.linkInvalidTitle)).toHaveCount(0);
  await expect(page.getByText(errors.linkInvalidBody)).toHaveCount(0);
});

test("RL-49: a doubled ?error= reads its first value", async ({ page }) => {
  await page.goto("/cuenta?error=linkInvalid&error=linkTimeout");

  await expect(page.getByText(errors.linkInvalidTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(errors.linkTimeoutTitle)).toHaveCount(0);
});

test("RL-49: an unknown ?error= value paints no notice", async ({ page }) => {
  await page.goto("/cuenta?error=nope");

  await expect(page.getByRole("textbox", { name: messages.account.emailLabel })).toBeVisible();
  for (const title of [errors.linkInvalidTitle, errors.linkTimeoutTitle, errors.linkOtherBrowserTitle]) {
    await expect(page.getByText(title)).toHaveCount(0);
  }
});
