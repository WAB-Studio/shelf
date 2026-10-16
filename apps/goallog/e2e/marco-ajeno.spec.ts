import { expect, test } from "@playwright/test";

// RP-60: no page of the app is framed by another site. The consent screen is
// the one a stolen click would land on, but the rule holds for every route.
const CONSENT = "/oauth/autorizar?response_type=code&client_id=marco-ajeno&state=x";

test.describe("headers on every response", () => {
  for (const path of [CONSENT, "/", "/semana", "/entrar", "/no-existe-esta-ruta"]) {
    test(`${path.split("?")[0]} refuses to be framed`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers()["x-frame-options"]).toBe("DENY");
    });
  }
});

test("the browser obeys: the consent screen does not load inside another page's frame", async ({ page, baseURL }) => {
  await page.setContent(`<iframe id="otro" src="${baseURL}${CONSENT}" width="600" height="600"></iframe>`);
  const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame());

  // A blocked frame ends on Chromium's error document, never on the app's.
  await expect.poll(() => frame()?.url() ?? "", { timeout: 15_000 }).toMatch(/^chrome-error:/);
  await expect(page.frameLocator("#otro").locator("h1")).toHaveCount(0);
});
