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
