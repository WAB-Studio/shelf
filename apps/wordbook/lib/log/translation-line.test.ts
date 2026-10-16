// RL-34: the translation a lookup records repeats nothing and is cut between
// translations, never through a word.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sense } from "@/lib/dictionary/index-build";

import { cutTranslation, formatSenseTranslations } from "./translation-line";

const LIMIT = 120;

function sense(...translations: string[]): Sense {
  return { pos: "n", ipa: null, translations, definition: null } as Sense;
}

test("formatSenseTranslations: a translation said twice by one word is recorded once", () => {
  // `left`: the dictionary lists «izquierdo» under two senses.
  const line = formatSenseTranslations([
    sense("izquierdo", "a la izquierda"),
    sense("izquierdo"),
  ]);
  assert.equal(line, "izquierdo, a la izquierda");
});

test("formatSenseTranslations: a repeat inside one sense is dropped too", () => {
  assert.equal(formatSenseTranslations([sense("casa", "hogar", "casa")]), "casa, hogar");
});

test("formatSenseTranslations: only an exact repeat is a repeat", () => {
  assert.equal(
    formatSenseTranslations([sense("Izquierdo", "izquierdo", "izquierdo ")]),
    "Izquierdo, izquierdo, izquierdo ",
  );
});

test("formatSenseTranslations: the first appearance keeps its place, order is never sorted", () => {
  const line = formatSenseTranslations([sense("zorro", "ave"), sense("zorro", "mono", "ave")]);
  assert.equal(line, "zorro, ave, mono");
});

test("formatSenseTranslations: reads only the first three senses, in order", () => {
  const line = formatSenseTranslations([sense("uno"), sense("dos"), sense("tres"), sense("cuatro")]);
  assert.equal(line, "uno, dos, tres");
});

test("formatSenseTranslations: a line over 120 ends at the last whole translation that fits", () => {
  // 9 translations of 14 chars: all joined is 142, seven fit (110), eight do not (126).
  const parts = Array.from({ length: 9 }, (_, i) => `traduccion-a${i + 1}0`);
  assert.ok(parts.every((p) => p.length === 14));
  const line = formatSenseTranslations([
    sense(...parts.slice(0, 3)),
    sense(...parts.slice(3, 6)),
    sense(...parts.slice(6, 9)),
  ]);
  assert.equal(line, parts.slice(0, 7).join(", "));
  assert.ok(line.length <= LIMIT);
});

test("formatSenseTranslations: a cut never ends in a separator or a word fragment", () => {
  const parts = Array.from({ length: 8 }, (_, i) => `palabra${i}-larga-xx`);
  const line = formatSenseTranslations([sense(...parts)]);
  assert.ok(line.length <= LIMIT);
  assert.ok(!/[,\s]$/u.test(line));
  assert.ok(parts.includes(line.split(", ").at(-1)!), `ends mid-word: ${line}`);
});

test("formatSenseTranslations: a cut adds no ellipsis and no new text", () => {
  const parts = Array.from({ length: 12 }, (_, i) => `traduccion-b${i}0`);
  const line = formatSenseTranslations([sense(...parts)]);
  assert.ok(parts.join(", ").startsWith(line));
  assert.ok(!line.includes("…") && !line.includes("..."));
});

test("formatSenseTranslations: one translation of 140 is cut at the last space before 120", () => {
  // Words of 8 chars: spaces fall at 8, 17, ..., 116, 125.
  const long = Array.from({ length: 16 }, (_, i) => `palab${String(i).padStart(3, "0")}`).join(" ");
  assert.ok(long.length >= 140);
  const line = formatSenseTranslations([sense(long)]);
  assert.equal(line, long.slice(0, long.lastIndexOf(" ", LIMIT)));
  assert.ok(line.length <= LIMIT);
  assert.ok(long.startsWith(line + " "));
});

test("formatSenseTranslations: a line of 80 comes out as it went in", () => {
  const eighty = "x".repeat(40) + " " + "y".repeat(39);
  assert.equal(eighty.length, 80);
  assert.equal(formatSenseTranslations([sense(eighty)]), eighty);
  assert.equal(formatSenseTranslations([sense("a", "b"), sense("c")]), "a, b, c");
});

test("formatSenseTranslations: exactly 120 is kept whole", () => {
  const exact = "z".repeat(55) + ", " + "w".repeat(63);
  assert.equal(exact.length, 120);
  assert.equal(formatSenseTranslations([sense("z".repeat(55), "w".repeat(63))]), exact);
});

test("formatSenseTranslations: a word with no translations records an empty line", () => {
  assert.equal(formatSenseTranslations([]), "");
});

test("cutTranslation: text of 80 is untouched; a joined list cuts between its translations", () => {
  assert.equal(cutTranslation("hola, mundo"), "hola, mundo");
  const parts = Array.from({ length: 10 }, (_, i) => `traduccion-c${i}0`);
  const cut = cutTranslation(parts.join(", "));
  assert.ok(cut.length <= LIMIT);
  assert.ok(parts.includes(cut.split(", ").at(-1)!), cut);
});

test("cutTranslation: a separator that starts at 120 keeps the whole first translation", () => {
  const first = `${"a".repeat(60)} ${"a".repeat(LIMIT - 61)}`;
  assert.equal(cutTranslation(`${first}, bbbb`), first);
});

test("cutTranslation: 121 characters with no break is cut to the 120 the wire schema allows", () => {
  const cut = cutTranslation("x".repeat(121));
  assert.ok(cut.length <= LIMIT, `got ${cut.length}`);
  assert.equal(cut, "x".repeat(LIMIT));
});

test("cutTranslation: a space at index 121 is past the cap and never the cut", () => {
  const text = `${"x".repeat(121)} ${"y".repeat(10)}`;
  const cut = cutTranslation(text);
  assert.ok(cut.length <= LIMIT, `got ${cut.length}`);
  assert.equal(cut, "x".repeat(LIMIT));
});
