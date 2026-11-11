import assert from "node:assert/strict";
import { test } from "node:test";

import { APK_CONTENT_TYPE, apkAsset, fetchLatestApk } from "./android-app";

const release = {
  assets: [
    { url: "https://api.github.com/a/1", name: "notes.txt", size: 3 },
    { url: "https://api.github.com/a/2", name: "homefund-avisos-v0.3.0.apk", size: 5 },
  ],
};

test("RF-194: the asset is the release's .apk", () => {
  assert.equal(apkAsset(release)?.name, "homefund-avisos-v0.3.0.apk");
  assert.equal(apkAsset({ assets: [] }), null);
  assert.equal(apkAsset(null), null);
});

test("RF-194: the APK streams with its type and filename, the token stays on the server", async () => {
  const seen: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
    return url.endsWith("/latest") ? Response.json(release) : new Response("apkdata");
  }) as unknown as typeof fetch;

  const response = await fetchLatestApk("tok", fake);

  assert.equal(response?.headers.get("content-type"), APK_CONTENT_TYPE);
  assert.match(response?.headers.get("content-disposition") ?? "", /filename="homefund-avisos-v0\.3\.0\.apk"/);
  assert.equal(await response?.text(), "apkdata");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((line) => line.endsWith("Bearer tok")));
});

test("RF-194: a refused release gives no download", async () => {
  const fake = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  assert.equal(await fetchLatestApk("tok", fake), null);
});
