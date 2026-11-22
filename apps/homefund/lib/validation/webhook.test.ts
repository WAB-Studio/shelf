import assert from "node:assert/strict";
import { test } from "node:test";

import { readLocation, webhookPayloadSchema } from "./webhook";

function locationOf(body: Record<string, unknown>) {
  const parsed = webhookPayloadSchema.safeParse({ text: "Compraste COP10.000", ...body });
  assert.ok(parsed.success, "a bad location never refuses the delivery");
  return readLocation(parsed.data);
}

test("numbers and numeric strings both carry a location", () => {
  assert.deepEqual(locationOf({ latitude: 4.711, longitude: -74.0721, accuracy: 12.4 }), {
    latitude: 4.711,
    longitude: -74.0721,
    accuracyM: 12,
  });
  assert.deepEqual(locationOf({ latitude: "4.711", longitude: " -74.0721 " }), {
    latitude: 4.711,
    longitude: -74.0721,
    accuracyM: null,
  });
});

test("a phone in Spanish sends the decimal comma", () => {
  assert.deepEqual(locationOf({ latitude: "4,711", longitude: "-74,0721", accuracy: "8,0" }), {
    latitude: 4.711,
    longitude: -74.0721,
    accuracyM: 8,
  });
});

test("garbage, out of range or half a pair stores no location and still parses", () => {
  assert.equal(locationOf({}), null);
  assert.equal(locationOf({ latitude: "norte", longitude: "oeste" }), null);
  assert.equal(locationOf({ latitude: 91, longitude: 10 }), null);
  assert.equal(locationOf({ latitude: 10, longitude: -181 }), null);
  assert.equal(locationOf({ latitude: 4.7 }), null);
  assert.equal(locationOf({ latitude: null, longitude: {} }), null);
  assert.equal(locationOf({ latitude: Number.NaN, longitude: 1 }), null);
});

test("a bad accuracy drops only the accuracy", () => {
  assert.deepEqual(locationOf({ latitude: 1, longitude: 2, accuracy: -5 }), { latitude: 1, longitude: 2, accuracyM: null });
  assert.deepEqual(locationOf({ latitude: 1, longitude: 2, accuracy: "mucha" }), { latitude: 1, longitude: 2, accuracyM: null });
});
