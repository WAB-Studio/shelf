import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// `app/layout.tsx` throws only past its own compile-time gate
// (docs/voyager/DESIGN.md "global-error.tsx gets a test hook"): a build the
// CI job did not arm with `VOYAGER_E2E_HOOKS=1` drops the branch below, so a
// reader running this suite against an ordinary build sees it skip rather
// than fail for a hole that was never actually open.
test.skip(
  process.env.VOYAGER_E2E_HOOKS !== "1",
  "requires a build with VOYAGER_E2E_HOOKS=1 (the voyager-e2e job's own build, never a Vercel one)",
);

test("a header-armed root layout crashes into global-error, not the nested boundary", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-voyager-e2e-crash": "root-layout" });

  const response = await page.goto("/");
  expect(response?.status()).toBe(500);

  await expect(page.getByText(messages.error.title)).toBeVisible();
  await expect(page.getByRole("button", { name: messages.error.retry })).toBeVisible();
});

test("the crash reaches a route below the root the same way", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-voyager-e2e-crash": "root-layout" });

  const response = await page.goto("/cuenta");
  expect(response?.status()).toBe(500);

  await expect(page.getByText(messages.error.title)).toBeVisible();
});
