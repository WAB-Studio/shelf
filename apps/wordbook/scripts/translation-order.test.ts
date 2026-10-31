import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { formatSenseTranslations } from "../lib/log/translation-line";
import { cleanGloss } from "./translation-order";

test("a gloss wrapped whole in quotation marks loses them; quotes inside a gloss stay", () => {
  assert.equal(cleanGloss('"bueno, por lo menos"'), "bueno, por lo menos");
  assert.equal(cleanGloss("“tarde, mal y nunca”"), "tarde, mal y nunca");
  assert.equal(cleanGloss('hora "peak"'), 'hora "peak"');
  assert.equal(cleanGloss("comoquiera"), "comoquiera");
});

test("the shipped asset carries no gloss that wears a wrapping or unmatched quotation mark", () => {
  const asset = path.join(import.meta.dirname, "../public/dictionary/eng-spa-2025.11.23.json");
  const entries = (JSON.parse(readFileSync(asset, "utf8")) as { entries: [string, string, unknown, string[]][] }).entries;
  const bad = entries.flatMap(([headword, , , glosses]) => glosses.filter((g) => (g.match(/["“”]/g) ?? []).length % 2 === 1 || /^["“]/.test(g)).map((g) => `${headword}: ${g}`));
  assert.deepEqual(bad, []);
  const anyway = entries.find(([headword]) => headword === "anyway");
  assert.ok(anyway !== undefined);
  assert.ok(!formatSenseTranslations([{ pos: "adv", ipa: null, translations: anyway[3], definition: null }]).includes('"'));
});
