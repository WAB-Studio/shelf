// Persisted shape only. No IO here: `record.ts` owns the database.

export const LOOKUP_SCHEMA = 3;

export type LookupOutcome =
  | "exact" // the string was a headword
  | "inflected" // reached through a lemma candidate
  | "miss" // the dictionary carries nothing for it
  | "translated" // a sentence, answered
  | "untranslated" // a sentence the translation failed on
  | "unlisted"; // a word with no entry, answered by the network

export type LookupRecord = {
  id?: number; // autoIncrement, assigned by the store
  schema: number; // on the row, not the database: rows outlive versions — the store holds schemas 1, 2 and 3 at once
  at: number; // Date.now(), epoch ms
  text: string; // as typed, trimmed and whitespace-collapsed, case preserved
  normalised: string; // normaliseHeadword(text) — the join key a deck is built on
  kind: "word" | "phrase";
  outcome: LookupOutcome;
  headword: string | null; // the headword actually reached; the lemma when inflected
  rule: string | null; // the InflectionRule value that reached it, as a plain string
  senses: number; // how many senses the group carried; 0 on a miss
  translation: string | null; // the answer's own translation text, joined and cut to 120 chars; null on miss/untranslated
  definition?: string | null; // an unlisted word's answer from the network, cut to 500 code points; absent under schema 1 and 2
  exampleEn?: string | null; // the answer's English example, same cut
  exampleEs?: string | null; // the answer's Spanish example, same cut
  dictionaryReady: boolean; // was the dictionary installed when the query was typed
  origin: "device" | "network" | null; // a sentence only
  device?: string | null; // the device that recorded it; absent means this one
  deviceSeq?: number | null; // its `id` there; absent means its own `id`
};

// The sync store's one row, keyed "state". A row this shape never existed
// under schema version 1: it is minted, not migrated.
export type SyncState = {
  deviceId: string; // minted once with crypto.randomUUID(), never rewritten
  pushedThroughLocalId: number | null; // highest local `id` already pushed
  pulledThroughCursor: string | null; // opaque server cursor already merged in, not a bare timestamp
  lastSyncedAt: number | null; // Date.now(), epoch ms
  enabled: boolean;
  readerId: string | null; // the `sub` of the reader the copy ran for; null before this was recorded
  retired: boolean; // the server retired this device: final, only a fresh deviceId copies again
};
