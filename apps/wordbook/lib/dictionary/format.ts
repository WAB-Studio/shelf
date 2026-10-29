import { z } from "zod";

// Bump this when RawEntry's shape changes; the worker refuses a payload whose
// version does not match its own.
export const PAYLOAD_VERSION = 1;

export const DICTIONARY_DIR = "/dictionary";
export const MANIFEST_PATH = "/dictionary/manifest.json";

// The six parts of speech the eng-spa 2025.11.23 extract carries. No entry in
// that edition uses a seventh.
export type PartOfSpeech = "n" | "adj" | "v" | "pn" | "adv" | "phraseologicalUnit";

// A tuple, not an object: 64,258 of these make up the payload, and the field
// names would be repeated once per entry on the wire.
export type RawEntry = readonly [
  headword: string,
  pos: PartOfSpeech,
  ipa: string | null,
  translations: readonly string[],
  definition: string | null,
];

export type DictionaryPayload = {
  version: number;
  entries: RawEntry[];
};

const partOfSpeechSchema = z.enum(["n", "adj", "v", "pn", "adv", "phraseologicalUnit"]);

export const manifestSchema = z.object({
  payloadVersion: z.literal(PAYLOAD_VERSION),
  source: z.object({
    url: z.string(),
    edition: z.string(),
    licence: z.literal("CC-BY-SA-3.0"),
    licenceUrl: z.string(),
    attribution: z.string(),
  }),
  builtAt: z.iso.datetime(),
  asset: z.object({
    path: z.string(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  counts: z.object({
    entries: z.number().int().nonnegative(),
    headwords: z.number().int().nonnegative(),
    withIpa: z.number().int().nonnegative(),
    multiWord: z.number().int().nonnegative(),
    byPos: z.record(partOfSpeechSchema, z.number().int().nonnegative()),
  }),
});

export type DictionaryManifest = z.infer<typeof manifestSchema>;

// The one normalisation the build script and the lookup engine share: a
// headword and a query must collapse to the same string or a lookup misses.
// Inner spaces survive so "give up" stays one headword, not two tokens.
export function normaliseHeadword(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}'-]+/u, "")
    .replace(/[^\p{L}\p{N}'-]+$/u, "");
}
