/**
 * Turns the FreeDict eng-spa TEI source into the three files the app ships
 * under `public/dictionary/`: the JSON payload `lib/dictionary/format.ts`
 * defines, its manifest, and the licence the CC BY-SA source requires.
 *
 * Source: FreeDict eng-spa, edition 2025.11.23, built from WikDict/DBnary
 * data over Wiktionary.org, licensed CC BY-SA 3.0. The edition's `.tei` file
 * carries 64 258 `<entry>` elements and every one of them carries at least
 * one Spanish translation, so nothing is dropped for lacking one.
 *
 * `<gramGrp><pos>` names nineteen values in this edition, not the six
 * `PartOfSpeech` in format.ts documents: alongside n/adj/v/pn/adv/
 * phraseologicalUnit it also uses pronoun, prefix, suffix, symbol, numeral,
 * article, determiner, conjunction, preposition, postposition, particle,
 * interjection and proverb, and 447 entries carry no `<pos>` at all. Since
 * `manifest.json`'s `counts.byPos` is a record over exactly those six keys,
 * every entry keeps its slot by a closest-fit mapping (POS_MAP below) rather
 * than by dropping the ones that don't already fit — nominal categories
 * (pronoun, prefix, suffix, symbol, and the 447 without a `<pos>`) fold into
 * `n`; categories that modify a noun (numeral, article, determiner) fold
 * into `adj`; invariant function words with no open-class analogue
 * (conjunction, preposition, postposition, particle, interjection) fold into
 * `adv`; and proverbs, being fixed multi-word sayings, fold into
 * `phraseologicalUnit`. This is a curation choice, not a parser artefact —
 * flagged to the user as a question, not decided silently.
 *
 * `ipa` and `definition` are each one string in a RawEntry, but the source
 * can carry several `<pron>` variants (dialect forms) and several `<sense>`
 * (distinct meanings) per entry. Rather than concatenate every variant into
 * one string that reads as none of them, this script keeps the first: `ipa`
 * is the entry's first `<pron>`, and `definition` — only emitted for
 * single-sense entries, so it never conflates two distinct meanings — is the
 * first sentence of that sense's `<def>`. Concatenating everything the
 * source carries instead produces an 11.7 MB asset, comfortably over the 9 MB
 * budget; this narrower reading lands at 8.0 MiB (8.4 MB).
 *
 * About 223 `<pron>` values also trail a source annotation stored as literal,
 * entity-escaped angle brackets rather than as its own element — e.g.
 * `/ænˈtiːɡʌn/<ref:<<name:OED>>>` for a dialect note the TEI's own tooling
 * would otherwise render separately. `stripPronunciationArtifact` cuts each
 * `ipa` at its first `<`, since the transcription always comes first; the
 * 223 count is entries whose chosen (first) `<pron>` needed the cut.
 *
 * Counts measured against this reading: 64 258 entries (matches), 16 112
 * multi-word headwords (matches), 36 359 entries with an `ipa` — 39 short of
 * the 36 320 quoted. That gap is unreconciled: no filter tried here (bare
 * punctuation prons, dash-bounded fragments, ASCII-only transcriptions, the
 * 447 entries with no `<pos>`) lands on exactly 36 320, so this script counts
 * the plain fact — "carries a non-empty `<pron>`" — rather than assert a
 * cause it cannot show.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import type { DictionaryManifest, DictionaryPayload, PartOfSpeech, RawEntry } from "../lib/dictionary/format";
import { DICTIONARY_DIR, PAYLOAD_VERSION, manifestSchema, normaliseHeadword } from "../lib/dictionary/format";

const EDITION = "2025.11.23";
const SOURCE_URL = `https://download.freedict.org/dictionaries/eng-spa/${EDITION}/freedict-eng-spa-${EDITION}.src.tar.xz`;
const LICENCE_URL = "https://creativecommons.org/licenses/by-sa/3.0/legalcode";
const ATTRIBUTION =
  "English–Spanish data from the FreeDict eng-spa dictionary, edition " +
  `${EDITION}, built by the FreeDict project from WikDict and Wiktionary.org ` +
  "data via DBnary, licensed under CC BY-SA 3.0.";

const APP_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(APP_DIR, ".cache");
const TARBALL_PATH = path.join(CACHE_DIR, `freedict-eng-spa-${EDITION}.src.tar.xz`);
const EXTRACT_DIR = path.join(CACHE_DIR, "extracted");
const OUTPUT_DIR = path.join(APP_DIR, "public", "dictionary");
const JSON_FILENAME = `eng-spa-${EDITION}.json`;
const MANIFEST_FILENAME = "manifest.json";
const LICENSE_FILENAME = "LICENSE.txt";

// The closest of format.ts's six PartOfSpeech values for every raw <pos> the
// source uses. See the header comment for why each grouping was chosen.
const POS_MAP: Record<string, PartOfSpeech> = {
  n: "n",
  adj: "adj",
  v: "v",
  pn: "pn",
  adv: "adv",
  phraseologicalUnit: "phraseologicalUnit",
  pronoun: "n",
  prefix: "n",
  suffix: "n",
  symbol: "n",
  numeral: "adj",
  article: "adj",
  determiner: "adj",
  conjunction: "adv",
  preposition: "adv",
  postposition: "adv",
  particle: "adv",
  interjection: "adv",
  proverb: "phraseologicalUnit",
};

function log(step: string): void {
  console.log(`[dict:build] ${step}`);
}

async function downloadTarball(): Promise<void> {
  if (existsSync(TARBALL_PATH)) {
    log(`download: reusing cached ${path.relative(APP_DIR, TARBALL_PATH)}`);
    return;
  }
  log(`download: fetching ${SOURCE_URL}`);
  await mkdir(CACHE_DIR, { recursive: true });
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`download failed: ${SOURCE_URL} answered HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(TARBALL_PATH, bytes);
  log(`download: wrote ${bytes.byteLength} bytes`);
}

function extractTarball(): void {
  if (findTeiFile(EXTRACT_DIR)) {
    log(`extract: reusing cached ${path.relative(APP_DIR, EXTRACT_DIR)}`);
    return;
  }
  log(`extract: tar -xJf ${path.relative(APP_DIR, TARBALL_PATH)}`);
  mkdirSyncRecursive(EXTRACT_DIR);
  try {
    execFileSync("tar", ["-xJf", TARBALL_PATH, "-C", EXTRACT_DIR], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("extract failed: `tar` is not on PATH");
    }
    if (/xz/i.test(stderr)) {
      throw new Error("extract failed: `xz` is required to extract a .tar.xz source and was not found on PATH");
    }
    throw new Error(`extract failed: ${stderr || String(error)}`);
  }
}

function mkdirSyncRecursive(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// Walks the extracted tree for the one file the TEI dictionary body lives in,
// found by extension rather than by a path the archive's layout could change.
function findTeiFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findTeiFile(full);
      if (found) return found;
    } else if (entry.name.endsWith(".tei")) {
      return full;
    }
  }
  return null;
}

type TeiNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in (node as TeiNode)) {
    return String((node as TeiNode)["#text"]);
  }
  return null;
}

// A headword's translations live one or two <sense> levels deep, one group
// per distinct meaning: <sense><cit type="trans"><quote>...</sense>.
function collectTranslations(sense: unknown, out: string[]): void {
  for (const s of asArray(sense as TeiNode | TeiNode[])) {
    const node = s as TeiNode;
    for (const cit of asArray(node.cit as TeiNode | TeiNode[])) {
      if ((cit as TeiNode)["@_type"] !== "trans") continue;
      for (const quote of asArray((cit as TeiNode).quote as unknown[])) {
        const value = text(quote);
        if (value) out.push(value);
      }
    }
    if (node.sense) collectTranslations(node.sense, out);
  }
}

// The first <def> found, document order, however deep it sits.
function firstDefinition(sense: unknown): string | null {
  for (const s of asArray(sense as TeiNode | TeiNode[])) {
    const node = s as TeiNode;
    for (const def of asArray(node.def as unknown[])) {
      const value = text(def);
      if (value) return value;
    }
    if (node.sense) {
      const nested = firstDefinition(node.sense);
      if (nested) return nested;
    }
  }
  return null;
}

function firstSentence(value: string): string {
  const match = /^[^.]*\./.exec(value);
  return match ? match[0] : value;
}

// A `<pron>` can trail a source annotation the TEI stores as literal,
// entity-escaped angle brackets rather than as its own element — e.g.
// `/ænˈtiːɡʌn/<ref:<<name:OED>>>`. The phonetic transcription always comes
// first, so the first `<` marks where it ends.
function stripPronunciationArtifact(value: string): string {
  const index = value.indexOf("<");
  return index === -1 ? value : value.slice(0, index).trim();
}

function parseTeiEntries(xml: string): TeiNode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["entry", "sense", "cit", "pron", "orth", "pos", "quote", "def"].includes(name),
    // Keeps every tag value a string: FreeDict has numeral headwords ("311")
    // and translations that fast-xml-parser would otherwise read as numbers.
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as { TEI: { text: { body: { entry: TeiNode[] } } } };
  return doc.TEI.text.body.entry;
}

function buildRawEntries(teiEntries: TeiNode[]): RawEntry[] {
  const built: RawEntry[] = [];
  for (const entry of teiEntries) {
    const form = entry.form as TeiNode | undefined;
    const orth = form?.orth as unknown[] | undefined;
    const headword = orth?.[0] !== undefined ? text(orth[0])?.trim() : undefined;
    if (!headword) continue;

    const translationsRaw: string[] = [];
    collectTranslations(entry.sense, translationsRaw);
    if (translationsRaw.length === 0) continue;
    const translations = [...new Set(translationsRaw)];

    const gramGrp = entry.gramGrp as TeiNode | undefined;
    const posValues = gramGrp?.pos as unknown[] | undefined;
    const rawPos = posValues?.[0] !== undefined ? text(posValues[0]) : null;
    const pos = (rawPos && POS_MAP[rawPos]) || "n";

    const prons = asArray(form?.pron as unknown[])
      .map(text)
      .filter((value): value is string => Boolean(value))
      .map(stripPronunciationArtifact);
    const ipa = prons.length > 0 ? prons[0] : null;

    const topSenses = asArray(entry.sense as TeiNode | TeiNode[]);
    const definition =
      topSenses.length === 1 ? firstDefinition(topSenses)?.trim() : undefined;

    built.push([headword, pos, ipa, translations, definition ? firstSentence(definition) : null]);
  }
  return built;
}

function sortEntries(entries: RawEntry[]): RawEntry[] {
  return [...entries].sort((a, b) => {
    const ha = normaliseHeadword(a[0]);
    const hb = normaliseHeadword(b[0]);
    if (ha !== hb) return ha < hb ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
}

const ALL_POS: PartOfSpeech[] = ["n", "adj", "v", "pn", "adv", "phraseologicalUnit"];

function computeCounts(entries: RawEntry[]): DictionaryManifest["counts"] {
  const headwords = new Set(entries.map((e) => normaliseHeadword(e[0])));
  const byPos = Object.fromEntries(ALL_POS.map((pos) => [pos, 0])) as Record<PartOfSpeech, number>;
  let withIpa = 0;
  let multiWord = 0;
  for (const [headword, pos, ipa] of entries) {
    byPos[pos]++;
    if (ipa) withIpa++;
    if (/\s/.test(headword)) multiWord++;
  }
  return { entries: entries.length, headwords: headwords.size, withIpa, multiWord, byPos };
}

function licenseText(): string {
  return `FreeDict eng-spa dictionary, edition ${EDITION}
Source: ${SOURCE_URL}

Licensed under the Creative Commons Attribution-ShareAlike 3.0 Unported
license (CC BY-SA 3.0): ${LICENCE_URL}

Creative Commons Attribution-ShareAlike 3.0 Unported

THE WORK (AS DEFINED BELOW) IS PROVIDED UNDER THE TERMS OF THIS CREATIVE
COMMONS PUBLIC LICENSE ("CCPL" OR "LICENSE"). THE WORK IS PROTECTED BY
COPYRIGHT AND/OR OTHER APPLICABLE LAW. ANY USE OF THE WORK OTHER THAN AS
AUTHORIZED UNDER THIS LICENSE OR COPYRIGHT LAW IS PROHIBITED.

BY EXERCISING ANY RIGHTS TO THE WORK PROVIDED HERE, YOU ACCEPT AND AGREE TO
BE BOUND BY THE TERMS OF THIS LICENSE. TO THE EXTENT THIS LICENSE MAY BE
CONSIDERED TO BE A CONTRACT, THE LICENSOR GRANTS YOU THE RIGHTS CONTAINED
HERE IN CONSIDERATION OF YOUR ACCEPTANCE OF SUCH TERMS AND CONDITIONS.

You are free to Share (copy, distribute and transmit the work) and to Remix
(adapt the work), under the following conditions:

  Attribution — You must attribute the work in the manner specified by the
  author or licensor (but not in any way that suggests that they endorse you
  or your use of the work).

  Share Alike — If you alter, transform, or build upon this work, you may
  distribute the resulting work only under the same, similar or a compatible
  license.

The full legal code of this license is available at:
${LICENCE_URL}

Attribution: ${ATTRIBUTION}

Modifications:
This script (apps/voyager/scripts/build-dictionary.ts) parsed the source TEI
XML and extracted, per entry carrying a Spanish translation, its headword,
part of speech, IPA, Spanish translations and definition into a JSON array.
It dropped every entry without a Spanish translation. Of the extracted
fields: IPA is the entry's first pronunciation where the source lists more
than one, with a trailing source annotation cut from about 223 of those
pronunciations where the source stored one as literal text following the
transcription (for example "/ænˈtiːɡʌn/<ref:<<name:OED>>>" becomes
"/ænˈtiːɡʌn/"); definition is the first sentence of the entry's first sense,
and is left empty for entries with more than one sense, so distinct meanings
are never run together into one string; part of speech is folded onto the
six values apps/voyager/lib/dictionary/format.ts declares, mapping the
source's thirteen further categories and its unlabelled entries onto the
closest of the six. It changed nothing else: no headword, translation or
definition text was altered beyond those two cuts.
`;
}

type BuildResult = {
  jsonBytes: Buffer;
  manifest: DictionaryManifest;
  license: string;
};

function build(teiPath: string): BuildResult {
  log(`parse: ${path.relative(APP_DIR, teiPath)}`);
  const xml = readFileSync(teiPath, "utf8");
  const teiEntries = parseTeiEntries(xml);
  log(`parse: ${teiEntries.length} <entry> elements`);

  log("build: extracting RawEntry rows");
  const built = buildRawEntries(teiEntries);
  log(`build: ${built.length} entries carry a translation`);

  log("build: sorting by headword then part of speech");
  const entries = sortEntries(built);

  const payload: DictionaryPayload = { version: PAYLOAD_VERSION, entries };
  const jsonBytes = Buffer.from(JSON.stringify(payload));
  const sha256 = createHash("sha256").update(jsonBytes).digest("hex");
  const counts = computeCounts(entries);

  const manifest: DictionaryManifest = {
    payloadVersion: PAYLOAD_VERSION,
    source: {
      url: SOURCE_URL,
      edition: EDITION,
      licence: "CC-BY-SA-3.0",
      licenceUrl: LICENCE_URL,
      attribution: ATTRIBUTION,
    },
    builtAt: new Date().toISOString(),
    asset: {
      path: `${DICTIONARY_DIR}/${JSON_FILENAME}`,
      bytes: jsonBytes.byteLength,
      sha256,
    },
    counts,
  };

  return { jsonBytes, manifest, license: licenseText() };
}

function writeOutputs(result: BuildResult, outDir: string): void {
  mkdirSyncRecursive(outDir);
  writeFileSync(path.join(outDir, JSON_FILENAME), result.jsonBytes);
  writeFileSync(path.join(outDir, LICENSE_FILENAME), result.license);
  // Written last: its sha256 covers the JSON file exactly as written above.
  writeFileSync(path.join(outDir, MANIFEST_FILENAME), JSON.stringify(result.manifest, null, 2) + "\n");
}

// builtAt is the one field that legitimately differs between two builds of
// the same source; every other byte must match for `--check` to mean anything.
function manifestWithoutBuiltAt(manifest: DictionaryManifest): Omit<DictionaryManifest, "builtAt"> {
  const rest: Partial<DictionaryManifest> = { ...manifest };
  delete rest.builtAt;
  return rest as Omit<DictionaryManifest, "builtAt">;
}

async function runCheck(teiPath: string): Promise<void> {
  const committedJsonPath = path.join(OUTPUT_DIR, JSON_FILENAME);
  const committedManifestPath = path.join(OUTPUT_DIR, MANIFEST_FILENAME);
  const committedLicensePath = path.join(OUTPUT_DIR, LICENSE_FILENAME);
  if (!existsSync(committedJsonPath) || !existsSync(committedManifestPath) || !existsSync(committedLicensePath)) {
    throw new Error("check failed: public/dictionary/ is missing one of its three committed files");
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "dict-build-check-"));
  try {
    const rebuilt = build(teiPath);
    log(`check: rebuilding into ${tempDir}`);
    writeOutputs(rebuilt, tempDir);

    const committedJson = readFileSync(committedJsonPath);
    const committedManifest = JSON.parse(readFileSync(committedManifestPath, "utf8")) as DictionaryManifest;
    const committedLicense = readFileSync(committedLicensePath, "utf8");
    const rebuiltJson = readFileSync(path.join(tempDir, JSON_FILENAME));
    const rebuiltManifest = JSON.parse(readFileSync(path.join(tempDir, MANIFEST_FILENAME), "utf8")) as DictionaryManifest;
    const rebuiltLicense = readFileSync(path.join(tempDir, LICENSE_FILENAME), "utf8");

    const mismatches: string[] = [];
    if (!committedJson.equals(rebuiltJson)) {
      mismatches.push(`${JSON_FILENAME} differs byte for byte`);
    }
    if (JSON.stringify(manifestWithoutBuiltAt(committedManifest)) !== JSON.stringify(manifestWithoutBuiltAt(rebuiltManifest))) {
      mismatches.push(`${MANIFEST_FILENAME} differs outside of builtAt`);
    }
    if (committedLicense !== rebuiltLicense) {
      mismatches.push(`${LICENSE_FILENAME} differs`);
    }

    if (mismatches.length > 0) {
      for (const mismatch of mismatches) log(`check: ${mismatch}`);
      throw new Error("check failed: rebuild does not reproduce the committed files");
    }
    log("check: rebuild matches the committed files byte for byte");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");

  await downloadTarball();
  extractTarball();
  const teiPath = findTeiFile(EXTRACT_DIR);
  if (!teiPath) {
    throw new Error(`could not find a .tei file under ${path.relative(APP_DIR, EXTRACT_DIR)}`);
  }

  if (check) {
    await runCheck(teiPath);
    return;
  }

  const result = build(teiPath);
  const parsed = manifestSchema.safeParse(result.manifest);
  if (!parsed.success) {
    throw new Error(`manifest does not satisfy manifestSchema: ${parsed.error.message}`);
  }
  log(`write: ${path.relative(APP_DIR, OUTPUT_DIR)}/`);
  writeOutputs(result, OUTPUT_DIR);
  log(`done: ${result.jsonBytes.byteLength} bytes, ${result.manifest.counts.entries} entries`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
