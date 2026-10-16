// A field the wire row carries reaches `mergeForeign` without this file
// listing it (RL-62 adds one). The response schema is replaced by a
// pass-through so what is under test is the driver's mapping alone.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const wire = {
  deviceId: OTHER, localId: 7, at: 1_700_000_000_123, text: "Cats", normalised: "cat", kind: "word",
  outcome: "inflected", headword: "cat", rule: "plural", senses: 2, translation: "gato", dictionaryReady: true,
  origin: "network", recordSchema: 3, receivedAt: "2026-10-08T10:00:00.000Z", x: { nested: 42 },
};

test("a wire field the driver never heard of arrives; identity is renamed; receivedAt is dropped", async () => {
  const merged: unknown[][] = [];
  const real = await import("./protocol");
  mock.module("./protocol", {
    namedExports: { ...real, syncResponseSchema: { parse: (value: unknown) => value } },
  });
  Object.assign(globalThis, {
    window: { dispatchEvent: () => true },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ accepted: 0, rows: [wire], cursor: "c1" }) }),
  });
  mock.module("../log/record", {
    namedExports: {
      readSyncState: async () => ({ enabled: true, readerId: "reader-1", deviceId: DEVICE, pushedThroughLocalId: null, pulledThroughCursor: null }),
      writeSyncState: async () => undefined,
      markRetired: async () => undefined,
    },
  });
  mock.module("../log/merge", {
    namedExports: {
      readSince: async () => ({ own: [], scannedThrough: null, scanned: 0 }),
      mergeForeign: async (rows: unknown[]) => (merged.push(rows), rows.length),
    },
  });
  const { syncNow } = await import("./driver");
  await syncNow();
  assert.deepEqual(merged, [[
    {
      schema: 3, at: 1_700_000_000_123, text: "Cats", normalised: "cat", kind: "word", outcome: "inflected",
      headword: "cat", rule: "plural", senses: 2, translation: "gato", dictionaryReady: true, origin: "network",
      device: OTHER, deviceSeq: 7, x: { nested: 42 },
    },
  ]]);
});
