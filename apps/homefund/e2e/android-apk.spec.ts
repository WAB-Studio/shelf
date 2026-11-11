/**
 * The Android app's download (RF-194): no session means the login; a signed-in member gets the
 * APK when the server holds the token, and the note's 503 when it does not.
 */
import { expect } from "@playwright/test";

import { test } from "./global-setup";

const ROUTE = "/es/settings/android/apk";
const APK = "application/vnd.android.package-archive";

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("is sent to the login and gets no APK", async ({ request }) => {
    const response = await request.get(ROUTE, { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location, response.url()).pathname).toBe("/es/login");
    expect(response.headers()["content-type"] ?? "").not.toContain(APK);
  });
});

test("a signed-in member gets the APK, or a 503 while it is not configured", async ({ request }) => {
  const response = await request.get(ROUTE, { maxRedirects: 0 });

  if (process.env.ANDROID_APK_GITHUB_TOKEN) {
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe(APK);
    expect(response.headers()["content-disposition"]).toMatch(/attachment; filename=".+\.apk"/);
  } else {
    expect(response.status()).toBe(503);
  }
});
