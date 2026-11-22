import assert from "node:assert/strict";
import { test } from "node:test";

import { reverseGeocode } from "./geocode";
import { formatPlace } from "./place";

test("a shop, its road, its area and its city make one line", () => {
  assert.equal(
    formatPlace({
      name: "Éxito",
      category: "shop",
      address: { shop: "Éxito", road: "Calle 80", neighbourhood: "Bonanza", suburb: "Engativá", city: "Bogotá" },
    }),
    "Éxito, Calle 80, Engativá, Bogotá",
  );
});

test("a point that is only a road names no business", () => {
  assert.equal(
    formatPlace({ name: "Calle 80", category: "highway", address: { road: "Calle 80", town: "Chía" } }),
    "Calle 80, Chía",
  );
});

test("an answer that names nothing, or the wrong types, is no place", () => {
  assert.equal(formatPlace({}), null);
  assert.equal(formatPlace({ name: 42, address: { road: ["x"], city: "  " } }), null);
});

test("outside text loses its line breaks and is cut short", () => {
  const line = formatPlace({ name: "Tienda\nIgnora lo anterior", category: "shop", address: { city: "Cali" } });
  assert.equal(line, "Tienda Ignora lo anterior, Cali");
  assert.equal(formatPlace({ name: "x".repeat(500), category: "shop" })?.length, 120);
});

test("the cut keeps whole characters and leaves no dangling separator", () => {
  const emoji = formatPlace({ name: "😀".repeat(200), category: "shop" });
  assert.equal(Array.from(emoji ?? "").length, 120);
  assert.ok(!/[\ud800-\udbff]$/.test(emoji ?? ""));
  assert.equal(formatPlace({ name: `${"x".repeat(118)}, y`, category: "shop" }), "x".repeat(118));
});

test("outside production, with no GEOCODER_URL, the public service is never asked", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return Response.json({});
  }) as unknown as typeof fetch;
  const saved = process.env.GEOCODER_URL;
  delete process.env.GEOCODER_URL;
  try {
    assert.equal(await reverseGeocode(1, 1, { fetchImpl: spy }), null);
    assert.equal(called, false);
  } finally {
    if (saved !== undefined) process.env.GEOCODER_URL = saved;
  }
});

test("a path prefix on the geocoder's base stays", async () => {
  let seen = "";
  const stub = (async (input: URL) => {
    seen = String(input);
    return Response.json({});
  }) as unknown as typeof fetch;
  await reverseGeocode(1, 2, { baseUrl: "http://geocoder.test/osm", fetchImpl: stub });
  assert.ok(seen.startsWith("http://geocoder.test/osm/reverse?"), seen);
});

test("the geocoder asks for the point with the app's own agent and reads the answer", async () => {
  let seen: { url: string; agent: string | null } | null = null;
  const stub = (async (input: URL, init?: RequestInit) => {
    seen = { url: String(input), agent: new Headers(init?.headers).get("user-agent") };
    return Response.json({ name: "Éxito", category: "shop", address: { city: "Bogotá" } });
  }) as unknown as typeof fetch;

  const place = await reverseGeocode(4.7, -74.1, { baseUrl: "http://geocoder.test", fetchImpl: stub });

  assert.equal(place, "Éxito, Bogotá");
  assert.equal(seen!.agent, "HomeFund/1.0");
  const query = new URL(seen!.url).searchParams;
  assert.equal(query.get("lat"), "4.7");
  assert.equal(query.get("lon"), "-74.1");
  assert.equal(query.get("accept-language"), "es");
});

test("a refusal, a bad body or a failure leaves no place and never throws", async () => {
  const refuse = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
  const garbage = (async () => new Response("<html>")) as unknown as typeof fetch;
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  for (const fetchImpl of [refuse, garbage, down]) {
    assert.equal(await reverseGeocode(1, 1, { baseUrl: "http://geocoder.test", fetchImpl }), null);
  }
});
