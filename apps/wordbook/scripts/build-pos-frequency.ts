/**
 * Reads a headword's real-use frequency per part of speech from SUBTLEX-US
 * with part-of-speech information, and writes the derived order into
 * `lib/dictionary/pos-frequency.ts` (RL-43). `groupFor` reads that file to
 * order a headword's senses by how often each is really used, instead of
 * `index-build.ts`'s fixed `POS_RANK`, which cannot put both "grudge"'s
 * noun first and "leave"'s verb first — no single rank gives both.
 *
 * Source: SUBTLEX-US frequency list with PoS and Zipf information, at
 * `private/subtlex-pos.xlsx` — not committed, and never downloaded by this
 * script. Get it from https://www.ugent.be/pp/experimentele-psychologie/en/
 * research/documents/subtlexus and place it there before running this.
 * Licensed CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/),
 * so the table this script writes carries the same licence — non-commercial,
 * share-alike — and the credit belongs on `/cuenta` beside the dictionary's
 * own (`components/account/account-info.tsx`).
 *
 * The workbook is a zip of XML parts; `unzip` (already relied on by
 * `build-dictionary.ts` for its own archive) extracts the two that matter —
 * `xl/sharedStrings.xml`, the string pool every text cell indexes into, and
 * `xl/worksheets/sheet1.xml`, the 74,287-row sheet itself — and
 * `fast-xml-parser` reads both, the same dependency `build-dictionary.ts`
 * already carries for the TEI source.
 *
 * Column A is the word, M is `All_PoS_SUBTLEX` and N is `All_freqs_SUBTLEX`:
 * two dot-separated lists in the same order, e.g. `Article.Adverb.Noun` and
 * `993445.33186.257`. Of SUBTLEX's raw labels, only five have a `PartOfSpeech`
 * this app's dictionary uses — Noun, Verb, Adjective, Adverb, Name — and a
 * word carrying the same one twice sums the two frequencies rather than
 * keeping the last. `phraseologicalUnit` has no SUBTLEX equivalent and never
 * gets a frequency, so a headword whose senses are only that keeps its
 * `POS_RANK` order regardless of what this table says.
 *
 * A word is worth a row only where it changes anything: the dictionary
 * headword must itself carry two or more distinct parts of speech (only
 * there does an order exist to get right), and SUBTLEX must score two or
 * more of exactly those parts of speech (a single scored one leaves nothing
 * to compare). Every other headword — one part of speech, or fewer than two
 * SUBTLEX scores among the ones it has — is left for `POS_RANK` to order,
 * unrecorded here.
 *
 * The order itself is what ships, not the frequencies behind it: `groupFor`
 * only ever needs which sense comes first, so each row is a string of
 * single-letter codes (n, v, j for adjective, d for adverb, p for the proper
 * -noun "Name" bucket) in descending-frequency order — "leave" writes "vn",
 * "grudge" writes "nv" — rather than the numbers themselves.
 *
 * Run: `npm run pos:build -w apps/voyager`, with the source in place. Rerun
 * it whenever `public/dictionary/`'s payload is rebuilt, since the set of
 * multi-part-of-speech headwords it intersects against comes from there.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { manifestSchema, normaliseHeadword, type PartOfSpeech, type RawEntry } from "../lib/dictionary/format";
import { POS_RANK } from "../lib/dictionary/index-build";

const APP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_DIR, "..", "..");
const XLSX_PATH = path.join(REPO_ROOT, "private", "subtlex-pos.xlsx");
const OUTPUT_PATH = path.join(APP_DIR, "lib", "dictionary", "pos-frequency.ts");

const LICENCE_URL = "https://creativecommons.org/licenses/by-nc-sa/4.0/";
const SOURCE_URL =
  "https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus";

// The five SUBTLEX-US labels this dictionary's PartOfSpeech distinguishes.
// Every other label SUBTLEX carries (Article, Pronoun, Preposition, ...) is
// dropped: this dictionary's senses never carry it, so a frequency for it
// orders nothing.
const LABEL_MAP: Record<string, Exclude<PartOfSpeech, "phraseologicalUnit">> = {
  Noun: "n",
  Verb: "v",
  Adjective: "adj",
  Adverb: "adv",
  Name: "pn",
};

// The single-letter code each scoreable PartOfSpeech writes into a row.
// n and v need no shortening; adj, adv and pn would each cost more bytes
// than the headword they annotate across 2,681 rows, so they collapse to
// one letter apiece. `index-build.ts` owns the matching decode step.
const SHORT_CODE: Record<Exclude<PartOfSpeech, "phraseologicalUnit">, string> = {
  n: "n",
  v: "v",
  adj: "j",
  adv: "d",
  pn: "p",
};

function log(step: string): void {
  console.log(`[pos:build] ${step}`);
}

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in (node as XmlNode)) return String((node as XmlNode)["#text"]);
  return null;
}

// A shared string is one <t>, or several <r><t> runs when Excel split it
// across mixed formatting (SUBTLEX does this for two of its 84,616 header
// labels; every word and value cell is a plain <t>).
function sharedStringText(node: unknown): string {
  const entry = node as { t?: unknown; r?: unknown[] };
  if (entry.t !== undefined) return text(entry.t) ?? "";
  if (entry.r) return entry.r.map((run) => text((run as { t?: unknown }).t) ?? "").join("");
  return "";
}

function readSharedStrings(xml: string): string[] {
  const parser = new XMLParser({ ignoreAttributes: true, isArray: (name) => ["si", "r"].includes(name), parseTagValue: false });
  const doc = parser.parse(xml) as { sst: { si: unknown[] } };
  return doc.sst.si.map(sharedStringText);
}

function columnLetter(ref: string): string {
  const match = /^([A-Z]+)/.exec(ref);
  if (!match) throw new Error(`cell reference carries no column letter: ${ref}`);
  return match[1];
}

// Reads one column's text value from a row's cells — null for a numeric
// cell or a column the row has none of, since A, M and N are always text.
function cellText(cells: XmlNode[], column: string, sharedStrings: string[]): string | null {
  const cell = cells.find((c) => columnLetter(String(c["@_r"])) === column);
  if (!cell || cell["@_t"] !== "s") return null;
  const index = text(cell.v);
  return index === null ? null : sharedStrings[Number(index)];
}

// Word (normalised) -> summed frequency per scoreable PartOfSpeech, over
// every SUBTLEX row, not yet narrowed to what the dictionary can use.
function readWordFrequencies(xlsxPath: string): Map<string, Partial<Record<Exclude<PartOfSpeech, "phraseologicalUnit">, number>>> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "pos-frequency-"));
  try {
    log(`extract: unzip xl/sharedStrings.xml xl/worksheets/sheet1.xml from ${path.relative(REPO_ROOT, xlsxPath)}`);
    execFileSync("unzip", ["-o", xlsxPath, "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml", "-d", tmpDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    log("parse: xl/sharedStrings.xml");
    const sharedStrings = readSharedStrings(readFileSync(path.join(tmpDir, "xl/sharedStrings.xml"), "utf8"));

    log("parse: xl/worksheets/sheet1.xml");
    const sheetXml = readFileSync(path.join(tmpDir, "xl/worksheets/sheet1.xml"), "utf8");
    const sheetParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      isArray: (name) => ["row", "c"].includes(name),
      parseTagValue: false,
    });
    const sheet = sheetParser.parse(sheetXml) as { worksheet: { sheetData: { row: XmlNode[] } } };
    const rows = sheet.worksheet.sheetData.row;
    log(`parse: ${rows.length} rows`);

    const header = asArray(rows[0].c as XmlNode | XmlNode[]);
    const posHeader = cellText(header, "M", sharedStrings);
    const freqHeader = cellText(header, "N", sharedStrings);
    if (posHeader !== "All_PoS_SUBTLEX" || freqHeader !== "All_freqs_SUBTLEX") {
      throw new Error(`column M/N headers moved: found ${JSON.stringify({ posHeader, freqHeader })}`);
    }

    const byWord = new Map<string, Partial<Record<Exclude<PartOfSpeech, "phraseologicalUnit">, number>>>();
    let mismatched = 0;
    for (let i = 1; i < rows.length; i++) {
      const cells = asArray(rows[i].c as XmlNode | XmlNode[]);
      const word = cellText(cells, "A", sharedStrings);
      const posList = cellText(cells, "M", sharedStrings);
      const freqList = cellText(cells, "N", sharedStrings);
      if (!word || !posList || !freqList) continue;

      const labels = posList.split(".");
      const freqs = freqList.split(".").map(Number);
      if (labels.length !== freqs.length) {
        mismatched++;
        continue;
      }

      const scored: Partial<Record<Exclude<PartOfSpeech, "phraseologicalUnit">, number>> = {};
      for (let j = 0; j < labels.length; j++) {
        const target = LABEL_MAP[labels[j]];
        if (!target) continue;
        scored[target] = (scored[target] ?? 0) + freqs[j];
      }
      if (Object.keys(scored).length === 0) continue;
      byWord.set(normaliseHeadword(word), scored);
    }
    log(`build: ${byWord.size} words scored, ${mismatched} rows dropped for a label/frequency count mismatch`);
    return byWord;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Every distinct PartOfSpeech the dictionary's own entries carry for a
// headword — the only fact that decides whether an order is worth ordering.
function readDictionaryPosSets(): Map<string, Set<PartOfSpeech>> {
  const manifestPath = path.join(APP_DIR, "public", "dictionary", "manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const payloadPath = path.join(APP_DIR, "public", manifest.asset.path);
  const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as { entries: RawEntry[] };

  const byHeadword = new Map<string, Set<PartOfSpeech>>();
  for (const [headword, pos] of payload.entries) {
    const key = normaliseHeadword(headword);
    const set = byHeadword.get(key);
    if (set) set.add(pos);
    else byHeadword.set(key, new Set([pos]));
  }
  return byHeadword;
}

function build(): Map<string, string> {
  const wordFrequencies = readWordFrequencies(XLSX_PATH);
  const dictionaryPosSets = readDictionaryPosSets();

  const table = new Map<string, string>();
  for (const [headword, posSet] of dictionaryPosSets) {
    if (posSet.size < 2) continue;

    const frequencies = wordFrequencies.get(headword);
    if (!frequencies) continue;

    // Only the parts of speech this headword actually has: a SUBTLEX score
    // for one it lacks (frequent as "record"/Adjective, 2 uses against its
    // 3,986 as a noun) orders nothing this dictionary ever shows.
    const scored = [...posSet].filter((pos): pos is Exclude<PartOfSpeech, "phraseologicalUnit"> => frequencies[pos as Exclude<PartOfSpeech, "phraseologicalUnit">] !== undefined);
    if (scored.length < 2) continue;

    // A tie (rare, but "match" scores two senses within a hair of each
    // other) falls back to POS_RANK rather than to whatever order the
    // dictionary payload happened to list the senses in.
    const ordered = scored.sort((a, b) => (frequencies[b] ?? 0) - (frequencies[a] ?? 0) || POS_RANK[a] - POS_RANK[b]);
    table.set(headword, ordered.map((pos) => SHORT_CODE[pos]).join(""));
  }
  return table;
}

function countChanged(table: Map<string, string>, dictionaryPosSets: Map<string, Set<PartOfSpeech>>): number {
  const DECODE: Record<string, PartOfSpeech> = { n: "n", v: "v", j: "adj", d: "adv", p: "pn" };
  let changed = 0;
  for (const [headword, codes] of table) {
    const posSet = dictionaryPosSets.get(headword);
    if (!posSet) continue;
    const scored = codes.split("").map((code) => DECODE[code]);
    const rankOrder = [...scored].sort((a, b) => POS_RANK[a] - POS_RANK[b]);
    if (rankOrder.join(",") !== scored.join(",")) changed++;
  }
  return changed;
}

function writeOutput(table: Map<string, string>): void {
  const rows = [...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = rows.map(([headword, codes]) => `  [${JSON.stringify(headword)}, ${JSON.stringify(codes)}],`).join("\n");

  const contents = `/**
 * GENERATED by apps/voyager/scripts/build-pos-frequency.ts. Do not hand-edit.
 * Rerun with the source at private/subtlex-pos.xlsx: npm run pos:build -w apps/voyager.
 *
 * Derived from SUBTLEX-US frequency list with PoS and Zipf information
 * (${SOURCE_URL}), licensed CC BY-NC-SA 4.0 (${LICENCE_URL}). This
 * table, being a derived work of a share-alike source, carries the same
 * licence. Its credit is shown at /cuenta (components/account/account-info.tsx).
 *
 * One row per headword the dictionary carries two or more senses for, where
 * SUBTLEX-US scores at least two of exactly those parts of speech: groupFor
 * (index-build.ts) reads the string as a real-use order rather than
 * POS_RANK's fixed one. Each character is one part of speech, most-used
 * first — n = noun, v = verb, j = adjective, d = adverb, p = proper noun —
 * so "leave" (verb before noun) writes "vn" and "grudge" (noun before its
 * rare verb) writes "nv". A headword with no row here keeps POS_RANK.
 */
export const POS_FREQUENCY_ORDER: ReadonlyMap<string, string> = new Map([
${entries}
]);
`;
  writeFileSync(OUTPUT_PATH, contents);
  log(`write: ${path.relative(APP_DIR, OUTPUT_PATH)}, ${table.size} rows, ${Buffer.byteLength(contents)} bytes`);
}

function main(): void {
  const table = build();
  const dictionaryPosSets = readDictionaryPosSets();
  const changed = countChanged(table, dictionaryPosSets);
  log(`measure: ${changed} of ${table.size} rows carry an order different from POS_RANK's`);
  writeOutput(table);
}

main();
