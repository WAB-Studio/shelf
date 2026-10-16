import assert from "node:assert/strict";
import test from "node:test";

import { readerFor } from "./registry";
import { readReadingLookups } from "./reading-lookups";

function withEnv(env: Record<string, string | undefined>, body: () => void): void {
  const saved = { seam: process.env.PULSAR_FAULT_SEAM, vercel: process.env.VERCEL };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of [
      ["PULSAR_FAULT_SEAM", saved.seam],
      ["VERCEL", saved.vercel],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("with the seam set and VERCEL unset the source reads as unreadable", async () => {
  let reader: ReturnType<typeof readerFor> = null;
  withEnv({ PULSAR_FAULT_SEAM: "reading_lookups", VERCEL: undefined }, () => {
    reader = readerFor("reading_lookups");
  });
  assert.ok(reader);
  assert.notEqual(reader, readReadingLookups);
  await assert.rejects(() => (reader as unknown as () => Promise<unknown>)(), /unreadable/);
});

test("on Vercel the seam is ignored: the real reader comes back", () => {
  withEnv({ PULSAR_FAULT_SEAM: "reading_lookups", VERCEL: "1" }, () => {
    assert.equal(readerFor("reading_lookups"), readReadingLookups);
  });
});

test("with no seam the real reader comes back, and an unknown key has none", () => {
  withEnv({ PULSAR_FAULT_SEAM: undefined, VERCEL: undefined }, () => {
    assert.equal(readerFor("reading_lookups"), readReadingLookups);
    assert.equal(readerFor("nobody"), null);
  });
});
