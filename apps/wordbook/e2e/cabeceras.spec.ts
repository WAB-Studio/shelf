import { expect, test } from "@playwright/test";

import manifest from "../public/dictionary/manifest.json";

const SECURITY_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

for (const path of ["/", "/cuenta", "/registro"]) {
  test(`${path} carries the four security headers`, async ({ request }) => {
    const response = await request.get(path);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers()[name], name).toBe(value);
    }
  });
}

test("an API answer carries them too, even a 401", async ({ request }) => {
  const response = await request.post("/api/log/sync");
  expect(response.status()).toBe(401);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers()[name], name).toBe(value);
  }
});

test("no response says who serves it", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["x-powered-by"]).toBeUndefined();
});

test("the dictionary asset keeps its immutable cache", async ({ request }) => {
  const response = await request.get(manifest.asset.path);
  expect(response.headers()["cache-control"]).toContain("immutable");
});

test("sw.js keeps max-age=0, must-revalidate", async ({ request }) => {
  const response = await request.get("/sw.js");
  expect(response.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
});
