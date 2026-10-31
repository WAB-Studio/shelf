import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { PAYLOAD_VERSION } from "../lib/dictionary/format";
import { formatSenseTranslations } from "../lib/log/translation-line";
import { cleanGloss, isInflectedGloss, rankTranslations } from "./translation-order";

test("a gloss wrapped whole in quotation marks loses them; quotes inside a gloss stay", () => {
  assert.equal(cleanGloss('"bueno, por lo menos"'), "bueno, por lo menos");
  assert.equal(cleanGloss("“tarde, mal y nunca”"), "tarde, mal y nunca");
  assert.equal(cleanGloss('hora "peak"'), 'hora "peak"');
  assert.equal(cleanGloss("comoquiera"), "comoquiera");
});

test("the shipped asset carries no gloss that wears a wrapping or unmatched quotation mark", () => {
  const asset = path.join(import.meta.dirname, `../public/dictionary/eng-spa-2025.11.23-v${PAYLOAD_VERSION}.json`);
  const entries = (JSON.parse(readFileSync(asset, "utf8")) as { entries: [string, string, unknown, string[]][] }).entries;
  const bad = entries.flatMap(([headword, , , glosses]) => glosses.filter((g) => (g.match(/["“”]/g) ?? []).length % 2 === 1 || /^["“]/.test(g)).map((g) => `${headword}: ${g}`));
  assert.deepEqual(bad, []);
  const anyway = entries.find(([headword]) => headword === "anyway");
  assert.ok(anyway !== undefined);
  assert.ok(!formatSenseTranslations([{ pos: "adv", ipa: null, translations: anyway[3], definition: null }]).includes('"'));
});

type AssetEntry = [string, string, unknown, string[]];

function assetGlosses(headword: string, pos: string): string[] {
  const asset = path.join(import.meta.dirname, `../public/dictionary/eng-spa-2025.11.23-v${PAYLOAD_VERSION}.json`);
  const entries = (JSON.parse(readFileSync(asset, "utf8")) as { entries: AssetEntry[] }).entries;
  const entry = entries.find(([word, entryPos]) => word === headword && entryPos === pos);
  assert.ok(entry !== undefined, `${headword} ${pos} is in the asset`);
  return entry[3];
}

test("the shipped asset leads common words with the meaning a reader means", () => {
  const mean = assetGlosses("mean", "v").slice(0, 3);
  assert.ok(mean.includes("significar") && mean.includes("querer decir"), mean.join(", "));
  assert.ok(assetGlosses("fair", "adj").slice(0, 3).includes("justo"));
  const bleak = assetGlosses("bleak", "adj");
  assert.ok(!bleak.includes("alegría"));
  assert.equal(bleak[0], "desolado");
  const book = assetGlosses("book", "n").slice(0, 3);
  assert.ok(!book.includes("libros"), book.join(", "));
  assert.equal(book[0], "libro");
});

test("an inflected form of a sibling gloss goes behind the rest", () => {
  assert.ok(isInflectedGloss("libros", ["libro", "libros"], "n"));
  assert.ok(isInflectedGloss("digo", ["digo", "decir"], "v"));
  assert.ok(!isInflectedGloss("libro", ["libro", "libros"], "n"));
  assert.ok(!isInflectedGloss("mala onda", ["mala", "mala onda"], "adj"));
  assert.deepEqual(rankTranslations("book", "n", ["libros", "libro"]), ["libro", "libros"]);
});

test("the shipped asset leads the commonest verbs and nouns with the translation a speaker gives first", () => {
  assert.equal(assetGlosses("run", "v")[0], "correr");
  assert.equal(assetGlosses("time", "n")[0], "tiempo");
  assert.equal(assetGlosses("set", "v")[0], "poner");
  assert.equal(assetGlosses("set", "n")[0], "conjunto");
  assert.equal(assetGlosses("get", "v")[0], "obtener");
  assert.equal(assetGlosses("take", "v")[0], "tomar");
  assert.equal(assetGlosses("go", "v")[0], "ir");
});

test("a reviewed lead outranks the model's pick, and a pick names only glosses the entry has", () => {
  assert.deepEqual(rankTranslations("bleak", "adj", ["alegría", "desolado", "sombrío"]).slice(0, 1), ["desolado"]);
  const picked = rankTranslations("run", "v", ["marchar", "andar", "correr", "ejecutar"]);
  assert.deepEqual(picked.slice(0, 3), ["correr", "marchar", "andar"]);
  assert.deepEqual(rankTranslations("run", "v", ["uno", "dos"]), ["uno", "dos"]);
});
