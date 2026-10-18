// A word typed fast costs one call: the decoration waits for a pause longer
// than a typing gap before it asks the paid route. The hook is driven as a
// plain function with the late-answer hook replaced by a recorder.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;
const TYPING_GAP_MS = 50;

const seen: { key: unknown; debounceMs: unknown }[] = [];

mock.module(here("./late-answer.ts"), {
  namedExports: {
    askLate: async () => ({ kind: "unreached" }),
    useLateAnswer: (key: unknown, _ask: unknown, _cache: unknown, debounceMs: unknown) => {
      seen.push({ key, debounceMs });
      return { kind: "idle" };
    },
  },
});

test("the decoration debounces by more than a typing gap, so letters typed at 50 ms settle once", async () => {
  const { useDecoration } = await import("./use-decoration");
  useDecoration("lighthouse", true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, "lighthouse");
  assert.ok(
    typeof seen[0].debounceMs === "number" && seen[0].debounceMs > TYPING_GAP_MS,
    `debounce ${String(seen[0].debounceMs)} ms must exceed a ${TYPING_GAP_MS} ms typing gap`,
  );
});

test("no headword yet asks about nothing", async () => {
  const { useDecoration } = await import("./use-decoration");
  seen.length = 0;
  useDecoration(null, true);
  assert.equal(seen[0].key, null);
});
