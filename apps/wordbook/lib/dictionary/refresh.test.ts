import assert from "node:assert/strict";
import { test } from "node:test";

import type { DictionaryManifest, DictionaryPayload } from "./format";
import { resolveDictionary, type DictionaryCopy } from "./refresh";

function copy(version: number): DictionaryCopy {
  return { manifest: { payloadVersion: version } as unknown as DictionaryManifest, payload: { version, entries: [] } as DictionaryPayload };
}

test("an old copy still answers when the refresh fails", async () => {
  const shown: DictionaryCopy[] = [];
  await resolveDictionary({
    read: async () => ({ ...copy(1), stale: true }),
    install: async () => {
      throw new Error("offline");
    },
    ready: (c) => shown.push(c),
  });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].payload.version, 1);
});

test("an old copy answers first and the new one replaces it once installed", async () => {
  const shown: number[] = [];
  await resolveDictionary({
    read: async () => ({ ...copy(1), stale: true }),
    install: async () => copy(2),
    ready: (c) => shown.push(c.payload.version),
  });
  assert.deepEqual(shown, [1, 2]);
});

test("a current copy is never refreshed, and no copy installs before answering", async () => {
  let installs = 0;
  const shown: number[] = [];
  await resolveDictionary({
    read: async () => ({ ...copy(2), stale: false }),
    install: async () => (installs++, copy(2)),
    ready: (c) => shown.push(c.payload.version),
  });
  assert.equal(installs, 0);
  await resolveDictionary({ read: async () => null, install: async () => (installs++, copy(2)), ready: (c) => shown.push(c.payload.version) });
  assert.deepEqual([installs, shown], [1, [2, 2]]);
});
