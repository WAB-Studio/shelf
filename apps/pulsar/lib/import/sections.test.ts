import assert from "node:assert/strict";
import test from "node:test";

import { bySection } from "./sections";

const lines = ["intro", "## Fuentes", "https://a.test", "| t | 1 |", "## Reglas", "una cosa", "### Fuentes", "otra"];
const at = (...n: number[]) => n.map((line) => ({ line }));

test("bySection groups each line under the nearest heading above it, in order of appearance", () => {
  const groups = bySection(at(3, 4, 6, 8), lines)!;
  assert.deepEqual(
    groups.map((g) => [g.heading, g.lines.map((l) => l.line)]),
    [
      ["Fuentes", [3, 4]],
      ["Reglas", [6]],
      ["Fuentes", [8]],
    ],
  );
});

test("bySection keeps two sections with one title apart and counts a heading line in its own section", () => {
  assert.deepEqual(bySection(at(2, 7), lines)!.map((g) => g.lines.length), [1, 1]);
});

test("bySection puts lines above every heading in one group with no heading", () => {
  assert.deepEqual(bySection(at(1, 3), lines)!.map((g) => g.heading), [null, "Fuentes"]);
});

test("bySection returns null when there is no text or no heading in it", () => {
  assert.equal(bySection(at(1), null), null);
  assert.equal(bySection(at(1), ["a", "b"]), null);
});

test("bySection drops closing hashes from the heading", () => {
  assert.equal(bySection(at(2), ["# Plan ##", "x"])![0].heading, "Plan");
});
