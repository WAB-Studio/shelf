/**
 * Drives the committed asset, `buildIndex` and the inflection resolver
 * against each other in Node, with no browser, no network and no database.
 * Reads only `public/dictionary/`; never regenerates it and never asserts a
 * fact the build script's own header already states.
 *
 * `manifest.json`'s `withIpa` (36,359) differs from the source-table figure
 * `docs/voyager/SPEC.md` §2 quotes (36,320): that 39-entry gap is
 * unreconciled and is the build script's finding, not this script's. D3
 * checks the payload against the manifest's own counts, never against the
 * older SPEC table.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { manifestSchema, type DictionaryPayload, type PartOfSpeech } from "../lib/dictionary/format";
import { buildIndex, groupFor, type DictionaryIndex } from "../lib/dictionary/index-build";
import { lemmaCandidates } from "../lib/dictionary/inflect";
import { INFLECTION_FIXTURE } from "../lib/dictionary/inflect.fixture";
import { IRREGULAR_FORMS } from "../lib/dictionary/irregular-forms";
import { hasEntry, lookupWord } from "../lib/dictionary/lookup";

const APP_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const MANIFEST_FULL_PATH = path.join(PUBLIC_DIR, "dictionary", "manifest.json");

// Lifted, not imported: this file is the only one this slice owns, so its
// pass/fail bookkeeping lives beside the assertions it counts.
let counter = 0;
let failed = false;
let passes = 0;
let failures = 0;

function next(name: string): string {
  counter += 1;
  return `D${counter}. ${name}`;
}

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (ok) passes += 1;
  else {
    failures += 1;
    failed = true;
  }
}

function report(): never {
  console.log("");
  console.log(`REPORT  ${passes} pass, ${failures} fail`);
  process.exit(failed ? 1 : 0);
}

const ALL_POS: readonly PartOfSpeech[] = ["n", "adj", "v", "pn", "adv", "phraseologicalUnit"];

// D1 — the manifest satisfies its own schema.
const manifestJson: unknown = JSON.parse(readFileSync(MANIFEST_FULL_PATH, "utf8"));
const parsedManifest = manifestSchema.safeParse(manifestJson);
assert(
  next("manifest.json satisfies manifestSchema"),
  parsedManifest.success,
  parsedManifest.success ? "parsed" : parsedManifest.error.message,
);
if (!parsedManifest.success) report();
const manifest = parsedManifest.data;

// D2 — the asset on disk matches the manifest's own byte length and sha256.
const assetFullPath = path.join(PUBLIC_DIR, manifest.asset.path.replace(/^\//, ""));
const assetBytes = readFileSync(assetFullPath);
const actualByteLength = statSync(assetFullPath).size;
const actualSha256 = createHash("sha256").update(assetBytes).digest("hex");
assert(
  next("the asset's byte length and sha256 equal the manifest's"),
  actualByteLength === manifest.asset.bytes && actualSha256 === manifest.asset.sha256,
  `bytes=${actualByteLength} (manifest ${manifest.asset.bytes}), sha256=${actualSha256} (manifest ${manifest.asset.sha256})`,
);

const payload = JSON.parse(assetBytes.toString("utf8")) as DictionaryPayload;

// D3 — counts.entries, counts.withIpa and counts.multiWord, checked against
// the manifest's own figures. Print the three actual figures regardless of
// the outcome: 64258 / 36359 / 16112 is the measured fact to build around,
// not 36320, which the build script's header already shows unreconciled.
const actualEntries = payload.entries.length;
const actualWithIpa = payload.entries.filter((entry) => entry[2] !== null).length;
const actualMultiWord = payload.entries.filter((entry) => /\s/.test(entry[0])).length;
assert(
  next("counts.entries, counts.withIpa and counts.multiWord match the manifest"),
  actualEntries === manifest.counts.entries &&
    actualWithIpa === manifest.counts.withIpa &&
    actualMultiWord === manifest.counts.multiWord,
  `entries=${actualEntries}, withIpa=${actualWithIpa}, multiWord=${actualMultiWord} ` +
    `(manifest: entries=${manifest.counts.entries}, withIpa=${manifest.counts.withIpa}, multiWord=${manifest.counts.multiWord})`,
);

// D4 — every pos in the payload is one of the six declared in format.ts.
const posSet = new Set<string>(ALL_POS);
const badPos = payload.entries.filter((entry) => !posSet.has(entry[1]));
assert(
  next("every entry's pos is one of the six declared PartOfSpeech values"),
  badPos.length === 0,
  badPos.length === 0
    ? `${actualEntries} entries checked`
    : `${badPos.length} entries carry an undeclared pos, e.g. "${badPos[0][1]}" on "${badPos[0][0]}"`,
);

// D5 — buildIndex's distinct headword count equals counts.headwords. The
// manifest counts normalised headwords (58944); raw distinct text is 59253.
const index: DictionaryIndex = buildIndex(payload);
assert(
  next("buildIndex's distinct headword count equals counts.headwords"),
  index.byHeadword.size === manifest.counts.headwords,
  `index carries ${index.byHeadword.size} headwords (manifest ${manifest.counts.headwords})`,
);

// D6 — "leave" carries both a v and an n sense.
const leaveGroup = groupFor(index, "leave");
const leaveHasVerb = leaveGroup?.senses.some((sense) => sense.pos === "v") ?? false;
const leaveHasNoun = leaveGroup?.senses.some((sense) => sense.pos === "n") ?? false;
assert(
  next('groupFor(index, "leave") carries both a v and an n sense'),
  leaveGroup !== null && leaveHasVerb && leaveHasNoun,
  leaveGroup === null
    ? '"leave" is absent from the index'
    : `senses: ${leaveGroup.senses.map((s) => s.pos).join(", ")}`,
);

// D7 — every pair in INFLECTION_FIXTURE resolves, exact or via inflection.
const unresolvedFixturePairs: string[] = [];
for (const { surface, lemma } of INFLECTION_FIXTURE) {
  const answer = lookupWord(index, surface);
  const resolvesExact = answer.exact?.headword === lemma;
  const resolvesViaInflection = answer.viaInflection.some((hit) => hit.lemma === lemma);
  if (!resolvesExact && !resolvesViaInflection) unresolvedFixturePairs.push(`${surface}->${lemma}`);
}
assert(
  next("every INFLECTION_FIXTURE pair reaches its lemma, exact or via inflection"),
  unresolvedFixturePairs.length === 0,
  unresolvedFixturePairs.length === 0
    ? `${INFLECTION_FIXTURE.length} pairs resolved`
    : `${unresolvedFixturePairs.length} unresolved: ${unresolvedFixturePairs.join(", ")}`,
);

// D8 — the multi-word population survives the build: "give up" resolves and
// at least 15,000 index headwords carry a space.
const spacedHeadwords = Array.from(index.byHeadword.keys()).filter((headword) => headword.includes(" "));
const giveUpResolves = hasEntry(index, "give up");
assert(
  next('hasEntry(index, "give up") is true and at least 15,000 headwords carry a space'),
  giveUpResolves && spacedHeadwords.length >= 15000,
  `"give up" resolves: ${giveUpResolves}; ${spacedHeadwords.length} headwords carry a space`,
);

// D9 — the coverage report. No threshold: this assertion cannot fail on the
// number, it prints it.
//
// Sample: every index headword made of lowercase letters only, one token, at
// least 3 letters long, walked at a fixed stride across the alphabetically
// sorted list so the sample spans the whole dictionary rather than clustering
// on "a"-. To each such lemma, every regular suffix rule this dictionary's
// resolver inverts is applied (plural -s/-es/-ies, past -ed/-ied/doubled,
// gerund -ing/-ing-e/doubled, comparative -er/-ier/doubled, superlative
// -est/-iest/doubled, adverb -ly/-ily, possessive 's), producing several
// surface forms per lemma. That set is unioned with every surface form in
// IRREGULAR_FORMS. The empty-string key (two entries, "&" and an emoji, that
// normalise to "") is excluded from both the sample and the index scan below,
// per the known dead spot: a blank query returns early in lookupWord and can
// never resolve.
const VOWELS = new Set(["a", "e", "i", "o", "u"]);
function isConsonantLetter(ch: string): boolean {
  return /^[a-z]$/.test(ch) && !VOWELS.has(ch);
}
function endsConsonantY(word: string): boolean {
  return word.length >= 2 && word.endsWith("y") && isConsonantLetter(word[word.length - 2]);
}
// Consonant-vowel-consonant, last consonant not w/x/y: the shape a single
// final consonant doubles before -ed/-ing/-er/-est ("stop" -> "stopped").
function endsCvc(word: string): boolean {
  if (word.length < 3) return false;
  const [a, b, c] = word.slice(-3);
  return isConsonantLetter(a) && VOWELS.has(b) && isConsonantLetter(c) && !["w", "x", "y"].includes(c);
}

function regularSurfaceForms(lemma: string): string[] {
  const forms = new Set<string>();
  forms.add(lemma + "s");
  if (/(?:s|x|z|ch|sh)$/.test(lemma)) forms.add(lemma + "es");
  if (endsConsonantY(lemma)) forms.add(lemma.slice(0, -1) + "ies");
  forms.add(lemma.endsWith("e") ? lemma + "d" : lemma + "ed");
  if (endsConsonantY(lemma)) forms.add(lemma.slice(0, -1) + "ied");
  if (endsCvc(lemma)) {
    const doubled = lemma + lemma[lemma.length - 1];
    forms.add(doubled + "ed");
    forms.add(doubled + "ing");
  }
  forms.add(lemma.endsWith("e") && !lemma.endsWith("ee") ? lemma.slice(0, -1) + "ing" : lemma + "ing");
  if (lemma.endsWith("e")) forms.add(lemma + "r");
  else if (endsConsonantY(lemma)) forms.add(lemma.slice(0, -1) + "ier");
  else forms.add(lemma + "er");
  if (lemma.endsWith("e")) forms.add(lemma + "st");
  else if (endsConsonantY(lemma)) forms.add(lemma.slice(0, -1) + "iest");
  else forms.add(lemma + "est");
  forms.add(endsConsonantY(lemma) ? lemma.slice(0, -1) + "ily" : lemma + "ly");
  forms.add(lemma + "'s");
  return Array.from(forms);
}

const singleWordLetterHeadwords = index.sortedHeadwords.filter(
  (headword) => headword.length >= 3 && /^[a-z]+$/.test(headword),
);
const MIN_SAMPLE_SIZE = 2000;
const TARGET_LEMMA_COUNT = 300;
const stride = Math.max(1, Math.floor(singleWordLetterHeadwords.length / TARGET_LEMMA_COUNT));

const regularSample = new Set<string>();
for (let i = 0; i < singleWordLetterHeadwords.length; i += stride) {
  for (const form of regularSurfaceForms(singleWordLetterHeadwords[i])) {
    regularSample.add(form);
  }
}

if (regularSample.size < MIN_SAMPLE_SIZE) {
  throw new Error(
    `the generated sample only reached ${regularSample.size} forms, below the ${MIN_SAMPLE_SIZE} the contract requires`,
  );
}

const irregularSample = new Set<string>();
for (const surface of IRREGULAR_FORMS.keys()) {
  if (surface.length > 0) irregularSample.add(surface);
}

const coverageSample = new Set<string>(regularSample);
for (const surface of irregularSample) coverageSample.add(surface);

function resolvedCountOf(sample: ReadonlySet<string>): number {
  let count = 0;
  for (const surface of sample) {
    if (hasEntry(index, surface)) count += 1;
  }
  return count;
}

// Reported separately, not only blended: the generated half is a closed
// loop — every form is built by appending the very suffix the resolver
// strips back off, so a rate there proves lemmaCandidates and this
// generator are inverses of each other, not that a reader's word gets
// found. The irregular half is the only non-circular signal: those surfaces
// come from a hand-written table that no rule reaches. Blending the two
// buries the real (irregular) rate inside a higher headline number.
const resolvedRegular = resolvedCountOf(regularSample);
const resolvedIrregular = resolvedCountOf(irregularSample);
const resolvedBlended = resolvedCountOf(coverageSample);
const pct = (numerator: number, denominator: number) =>
  denominator === 0 ? "0.0" : ((numerator / denominator) * 100).toFixed(1);

assert(
  next("coverage report: generated-only, irregular-only and blended (no threshold)"),
  true,
  `generated (closed loop, suffix appended then stripped back off): ` +
    `${resolvedRegular}/${regularSample.size} = ${pct(resolvedRegular, regularSample.size)}%; ` +
    `irregular (the honest signal, a hand-written table no rule reaches): ` +
    `${resolvedIrregular}/${irregularSample.size} = ${pct(resolvedIrregular, irregularSample.size)}%; ` +
    `blended: ${resolvedBlended}/${coverageSample.size} = ${pct(resolvedBlended, coverageSample.size)}% ` +
    `(sample: ${regularSample.size} regular forms from ${Math.ceil(singleWordLetterHeadwords.length / stride)} ` +
    `stride-sampled single-word letter headwords, union ${irregularSample.size} IRREGULAR_FORMS surfaces)`,
);

// D10 — p95 of lookupWord over 1,000 headwords, in Node, under 1 ms. A
// floor: Node is faster than the phone RNL-01 is measured on.
const TIMING_SAMPLE_SIZE = 1000;
const allHeadwords = index.sortedHeadwords;
const timingStride = Math.max(1, Math.floor(allHeadwords.length / TIMING_SAMPLE_SIZE));
const timingSample: string[] = [];
for (let i = 0; i < allHeadwords.length && timingSample.length < TIMING_SAMPLE_SIZE; i += timingStride) {
  timingSample.push(allHeadwords[i]);
}
// Warm up the JIT on a disjoint slice before the timed pass.
for (let i = 1; i < allHeadwords.length && i < 400; i += 2) lookupWord(index, allHeadwords[i]);

const timingsMs: number[] = [];
for (const headword of timingSample) {
  const start = process.hrtime.bigint();
  lookupWord(index, headword);
  const end = process.hrtime.bigint();
  timingsMs.push(Number(end - start) / 1_000_000);
}
timingsMs.sort((a, b) => a - b);
const p95Index = Math.min(timingsMs.length - 1, Math.ceil(timingsMs.length * 0.95) - 1);
const p95Ms = timingsMs[p95Index];
assert(
  next(`p95 of lookupWord over ${TIMING_SAMPLE_SIZE} headwords is under 1 ms in Node`),
  p95Ms < 1,
  `p95=${p95Ms.toFixed(4)} ms over ${timingsMs.length} calls`,
);

// D11 — no headword's answer claims a comparative or superlative reading
// whose target carries no adj sense: "her" is not a form of "he", "beer"
// is not a form of "be"/"bee", "baker" is not a form of "bake". Measured
// against every headword the dictionary carries, not three examples.
// preFilterFalseCount reruns lemmaCandidates without lookupWord's own
// plausibility check, to report how large the surface was before it.
let preFilterFalseHeadwords = 0;
let postFilterFalseHeadwords = 0;
const stillFalseExamples: string[] = [];
for (const headword of index.sortedHeadwords) {
  const compSup = lemmaCandidates(headword).filter(
    (c) => (c.rule === "comparative" || c.rule === "superlative") && c.lemma !== headword,
  );
  const hadImplausible = compSup.some((c) => {
    const g = groupFor(index, c.lemma);
    return g !== null && !g.senses.some((s) => s.pos === "adj");
  });
  if (hadImplausible) preFilterFalseHeadwords++;

  const shipped = lookupWord(index, headword).viaInflection.filter(
    (h) => h.rule === "comparative" || h.rule === "superlative",
  );
  const stillImplausible = shipped.some((h) => !h.group.senses.some((s) => s.pos === "adj"));
  if (stillImplausible) {
    postFilterFalseHeadwords++;
    if (stillFalseExamples.length < 10) stillFalseExamples.push(headword);
  }
}
assert(
  next("no shipped comparative/superlative hit targets a headword without an adj sense"),
  postFilterFalseHeadwords === 0,
  postFilterFalseHeadwords === 0
    ? `${preFilterFalseHeadwords} headwords carried an implausible hit before the adj filter, 0 after`
    : `${postFilterFalseHeadwords} headwords still carry one: ${stillFalseExamples.join(", ")}`,
);

// D12 — no shipped inflected hit is a bare single-letter lemma outside
// "a"/"i", or a regular guess toward a lemma the irregular table already
// governs for the matching part of speech: "bed" is not a form of "b" nor
// of "be" — "be"'s real past is "was"/"were", a form no suffix rule here
// produces. Reimplements both checks inline, against only `lemmaCandidates`
// and `IRREGULAR_FORMS`, the same way D11 reimplements its own adj check —
// so this proves the filter at `lookupWord`'s boundary, not through the
// private helper that already enforces it.
const ANSWERABLE_SINGLE_CHAR = new Set(["a", "i"]);
const IRREGULAR_TABLE_LEMMAS = new Set(Array.from(IRREGULAR_FORMS.values()).flat());
const PAST_TENSE_RULES = new Set(["past-ed", "past-ied", "past-doubled"]);
const PLURAL_RULES = new Set(["plural-s", "plural-es", "plural-ies"]);

let preFilterBadCandidates = 0;
let postFilterBadHits = 0;
const stillBadExamples: string[] = [];
for (const headword of index.sortedHeadwords) {
  const candidates = lemmaCandidates(headword).filter((c) => c.lemma !== headword);
  const bad = candidates.filter((c) => {
    const group = groupFor(index, c.lemma);
    if (!group) return false;
    const oneLetterLemma = c.lemma.length === 1 && !ANSWERABLE_SINGLE_CHAR.has(c.lemma);
    const overriddenByTable =
      IRREGULAR_TABLE_LEMMAS.has(c.lemma) &&
      ((PAST_TENSE_RULES.has(c.rule) && group.senses.some((s) => s.pos === "v")) ||
        (PLURAL_RULES.has(c.rule) &&
          group.senses.some((s) => s.pos === "n") &&
          !group.senses.some((s) => s.pos === "v")));
    return oneLetterLemma || overriddenByTable;
  });
  preFilterBadCandidates += bad.length;

  const shipped = lookupWord(index, headword).viaInflection;
  const stillBad = bad.filter((c) => shipped.some((h) => h.lemma === c.lemma && h.rule === c.rule));
  if (stillBad.length > 0) {
    postFilterBadHits += stillBad.length;
    if (stillBadExamples.length < 10) stillBadExamples.push(`${headword}->${stillBad[0].lemma}`);
  }
}
assert(
  next("no shipped inflected hit is a one-letter lemma or overridden by the irregular table"),
  postFilterBadHits === 0,
  postFilterBadHits === 0
    ? `${preFilterBadCandidates} candidates carried one of these two defects before the filter, 0 after`
    : `${postFilterBadHits} still shipped: ${stillBadExamples.join(", ")}`,
);

// D13 — RL-43: the measured order actually reaches `groupFor`. D6 above proves
// "leave" carries both senses; nothing proved which came first, so reverting
// the frequency table left every check green. These eleven are the words the
// order was decided on: `grudge` is the reader's own complaint, `leave` is
// the case POS_RANK was hand-tuned for, and no single fixed rank gives both.
const FREQUENCY_ORDER_CASES: ReadonlyArray<readonly [string, readonly PartOfSpeech[]]> = [
  ["grudge", ["n", "v"]],
  ["leave", ["v", "n"]],
  ["light", ["n", "adj", "v"]],
  ["run", ["v", "n"]],
  // Three senses, two of them scored: the unmeasured `adj` falls to POS_RANK
  // behind both, which is the fallback this order is built on.
  ["fire", ["n", "v", "adj"]],
  ["record", ["n", "v"]],
  ["bank", ["n", "v"]],
  ["match", ["n", "v"]],
  ["book", ["n", "v"]],
  ["water", ["n", "v"]],
  ["present", ["n", "v", "adj"]],
];

const wrongOrder = FREQUENCY_ORDER_CASES.filter(([headword, expected]) => {
  const group = groupFor(index, headword);
  if (group === null) return true;
  // Senses repeat a part of speech; the group order is the order its
  // categories first appear, which is what the screen draws as its labels.
  const drawn: PartOfSpeech[] = [];
  for (const sense of group.senses) if (!drawn.includes(sense.pos)) drawn.push(sense.pos);
  return drawn.join(",") !== expected.join(",");
});
assert(
  next("every sense group is ordered by measured frequency, not by POS_RANK"),
  wrongOrder.length === 0,
  wrongOrder.length === 0
    ? `${FREQUENCY_ORDER_CASES.length} headwords in their measured order, "grudge" as n before v`
    : wrongOrder
        .map(([headword, expected]) => {
          const group = groupFor(index, headword);
          const drawn = group === null ? "absent" : [...new Set(group.senses.map((s) => s.pos))].join(",");
          return `${headword}: drew ${drawn}, measured ${expected.join(",")}`;
        })
        .join("; "),
);

// D14 — RL-28: a one-edit miss recovers the headword it was one edit away
// from, 100% of the time. No cap survives
// on `edit-distance.ts`'s own candidate count. Sample is every 50th eligible
// headword (length >= 4, plain a-z), its middle character deleted, so a red
// here reruns identically. A corruption that happens to land on another
// real answer — "grueling" reads as "gruel"+"-ing" before it ever reaches
// `suggestCorrection`, "met" is a headword in its own right — is not a miss
// at all, so it is excluded rather than counted as a false recovery.
const editableHeadwords = index.sortedHeadwords.filter((w) => /^[a-z]+$/.test(w) && w.length >= 4);
const sample = editableHeadwords.filter((_, i) => i % 50 === 0);
let recovered = 0;
let tested = 0;
const missedExamples: string[] = [];
for (const headword of sample) {
  const mid = Math.floor(headword.length / 2);
  const typo = headword.slice(0, mid) + headword.slice(mid + 1);
  const typoAnswer = lookupWord(index, typo);
  if (typoAnswer.exact !== null || typoAnswer.viaInflection.length > 0) continue; // not a miss
  tested++;
  if (typoAnswer.correction.includes(headword)) recovered++;
  else if (missedExamples.length < 10) missedExamples.push(`${headword}->${typo}`);
}
assert(
  next("a one-edit typo of a sampled headword recovers it in lookupWord's own correction field, 100% of the time"),
  recovered === tested,
  `${recovered}/${tested} recovered (${sample.length - tested} of the ${sample.length} sampled excluded as not misses), missed: ${missedExamples.join(", ") || "none"}`,
);

// D15 and D16 — `fettle` sits one substitution from four real headwords (kettle,
// mettle, nettle, settle) and gets all four: RL-28 corrects every one-edit miss with no cap, knowing
// `fettle` is not a typo but a real word the dictionary lacks — RL-44 is what tells
// that reader none of the four is what they meant, not this guard.
// `zzqqxv` has no headword within one edit at all, which stays empty.
const fettleCorrection = lookupWord(index, "fettle").correction;
const zzqqxvCorrection = lookupWord(index, "zzqqxv").correction;
assert(
  next("fettle's four equally-close headwords all come back, uncapped"),
  fettleCorrection.length === 4 && ["kettle", "mettle", "nettle", "settle"].every((w) => fettleCorrection.includes(w)),
  `correction=[${fettleCorrection.join(", ")}]`,
);
assert(
  next("zzqqxv, with no headword within one edit, gets no correction"),
  zzqqxvCorrection.length === 0,
  `correction=[${zzqqxvCorrection.join(", ")}]`,
);

// D17 — the third-person-singular family. English spells the noun plural
// and the third-person-singular present with the same "-s", and the
// irregular-table override used to reject a plural guess on the target
// carrying a noun sense alone — which threw away "goes", "runs", "sees"
// and every other "-s" form of a verb whose lemma also happens to name a
// noun. Drives every IRREGULAR_TABLE_LEMMAS entry that carries a verb
// sense (the population the bug could reach, not three hand-picked
// words), builds each one's real third-person-singular spelling by the
// standard English rule, and checks it resolves back to the lemma.
function thirdPersonSingular(lemma: string): string {
  if (/(?:[sxz]|ch|sh)$/.test(lemma)) return lemma + "es";
  if (endsConsonantY(lemma)) return lemma.slice(0, -1) + "ies";
  if (lemma.length >= 2 && lemma.endsWith("o") && isConsonantLetter(lemma[lemma.length - 2])) return lemma + "es";
  return lemma + "s";
}

const verbIrregularLemmas = Array.from(IRREGULAR_TABLE_LEMMAS).filter((lemma) => {
  const group = groupFor(index, lemma);
  return group !== null && group.senses.some((s) => s.pos === "v");
});

let thirdPersonResolved = 0;
const thirdPersonMissed: string[] = [];
for (const lemma of verbIrregularLemmas) {
  const surface = thirdPersonSingular(lemma);
  const answer = lookupWord(index, surface);
  const resolves = answer.exact?.headword === lemma || answer.viaInflection.some((h) => h.lemma === lemma);
  if (resolves) thirdPersonResolved++;
  else if (thirdPersonMissed.length < 15) thirdPersonMissed.push(`${surface}->${lemma}`);
}
assert(
  next("every irregular-table lemma with a verb sense reaches it from its third-person-singular '-s' form"),
  thirdPersonResolved === verbIrregularLemmas.length,
  `${thirdPersonResolved}/${verbIrregularLemmas.length} resolved` +
    (thirdPersonMissed.length === 0 ? "" : `, missed: ${thirdPersonMissed.join(", ")}`),
);

// D18 — RL-28: candidates a POS_FREQUENCY_ORDER row exists for sort ahead of
// candidates it does not, alphabetical within each block. The
// table carries no number, so a rowed candidate is
// never ranked against another rowed one — only rowed-or-not is honest.
// "bame" moves 8 of its 13 candidates ahead of the other 5; "fettle" is
// unchanged, since none of kettle/mettle/nettle/settle carries a row. Named
// exactly, not just "returned": an unordered check stays green when the
// order it was written to prove regresses to plain alphabetical.
const bameCorrection = lookupWord(index, "bame").correction;
const fettleOrderCorrection = lookupWord(index, "fettle").correction;
assert(
  next("suggestCorrection ranks a candidate with a POS_FREQUENCY_ORDER row ahead of one without, alphabetical within each block"),
  JSON.stringify(bameCorrection) ===
    JSON.stringify(["bale", "bare", "base", "blame", "game", "lame", "name", "tame", "bae", "bake", "bane", "fame", "same"]) &&
    JSON.stringify(fettleOrderCorrection) === JSON.stringify(["kettle", "mettle", "nettle", "settle"]),
  `bame=[${bameCorrection.join(", ")}], fettle=[${fettleOrderCorrection.join(", ")}]`,
);

report();
