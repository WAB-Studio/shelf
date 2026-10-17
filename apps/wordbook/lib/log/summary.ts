import { openLogDatabase } from "./record";
import type { LookupOutcome, LookupRecord } from "./types";

// The registro's third reader of `lookups` (RL-56), beside `history.ts`'s
// page and `merge.ts`'s two writes: a single cursor pass over the
// `normalised` index, grouping as it walks instead of loading every row.

const STORE_NAME = "lookups";
const NORMALISED_INDEX = "normalised";
const HEADWORD_INDEX = "headword";

// A row minted before a field existed has no such key (`translation` under
// schema 1, the network's answer under 1 and 2), so IndexedDB hands the
// cursor `undefined` where a reader wants `string | null`. Both
// readers below cast a raw cursor value through this, once, at the point a
// row enters the module, rather than each folding `?? null` on its own.
function readRecord(value: unknown): LookupRecord {
  const record = value as LookupRecord;
  return {
    ...record,
    translation: record.translation ?? null,
    definition: record.definition ?? null,
    exampleEn: record.exampleEn ?? null,
    exampleEs: record.exampleEs ?? null,
  };
}

export type StudyRow = {
  // The lemma reached, or `normalised` for a row with none (a phrase, an
  // unlisted word).
  key: string;
  // The group's first form in index order; always a key with rows of its own.
  normalised: string;
  forms: { text: string; count: number }[];
  display: string;
  count: number;
  lastAt: number;
  lastTranslation: string | null;
  // The newest record's network definition; `null` when that record has none.
  lastDefinition: string | null;
  lastOutcome: LookupOutcome;
};

// Forms carry the time they were last searched while grouping, so the
// finished row can order them; `StudyRow` hands callers the order alone.
type Group = Omit<StudyRow, "forms"> & { forms: { text: string; count: number; at: number }[] };

function addForm(forms: Group["forms"], text: string, at: number): Group["forms"] {
  const seen = forms.find((form) => form.text === text);
  return seen
    ? forms.map((form) =>
        form === seen ? { text, count: form.count + 1, at: Math.max(form.at, at) } : form,
      )
    : [...forms, { text, count: 1, at }];
}

function finishGroup(group: Group): StudyRow {
  const forms = [...group.forms]
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .map(({ text, count }) => ({ text, count }));
  return { ...group, forms };
}

function foldRow(group: Group | undefined, record: LookupRecord): Group {
  if (!group) {
    return {
      key: record.headword ?? record.normalised,
      forms: [{ text: record.normalised, count: 1, at: record.at }],
      normalised: record.normalised,
      display: record.text,
      count: 1,
      lastAt: record.at,
      lastTranslation: record.translation,
      lastDefinition: record.definition ?? null,
      lastOutcome: record.outcome,
    };
  }
  const newer = record.at > group.lastAt;
  return {
    key: group.key,
    forms: addForm(group.forms, record.normalised, record.at),
    normalised: group.normalised,
    display: newer ? record.text : group.display,
    count: group.count + 1,
    lastAt: newer ? record.at : group.lastAt,
    lastTranslation: newer ? record.translation : group.lastTranslation,
    lastDefinition: newer ? (record.definition ?? null) : group.lastDefinition,
    lastOutcome: newer ? record.outcome : group.lastOutcome,
  };
}

/**
 * Groups every row in `lookups` by the lemma it reached (`headword`, or
 * `normalised` when it reached none), each group listing its forms, in one read transaction. `rows` sorts by how often a word was
 * searched, then by how recently, at most `limit` of them; `total` counts
 * every group, not every row, so a caller can show "3 of 412" honestly.
 */
export async function readWordStudy(limit?: number): Promise<{ rows: StudyRow[]; total: number }> {
  const database = await openLogDatabase();
  const groups = await new Promise<Map<string, Group>>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index(NORMALISED_INDEX).openCursor();
    const found = new Map<string, Group>();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(found);
        return;
      }
      const record = readRecord(cursor.value);
      const key = record.headword ?? record.normalised;
      found.set(key, foldRow(found.get(key), record));
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const rows = [...groups.values()].map(finishGroup).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return { rows: limit === undefined ? rows : rows.slice(0, limit), total: groups.size };
}

export type WordHistoryRow = {
  at: number;
  text: string;
  outcome: LookupOutcome;
  translation: string | null;
  definition: string | null;
  exampleEn: string | null;
  exampleEs: string | null;
  // A sentence's own row: its answer is `translation` above, never a
  // dictionary headword — RL-34's own distinction, the caller's to read.
  kind: LookupRecord["kind"];
};

type FoundRow = WordHistoryRow & { id: number };

/**
 * The lemma a written form answers to, read off the form's own rows: the
 * `headword` of the most recent one, or the form itself when that row has
 * none or the form was never searched. One cursor bounded to the form.
 */
export async function readLemmaKey(normalised: string): Promise<string> {
  const database = await openLogDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const request = transaction.objectStore(STORE_NAME).index(NORMALISED_INDEX).openCursor(IDBKeyRange.only(normalised));
  return new Promise<string>((resolve, reject) => {
    let latest: LookupRecord | undefined;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(latest?.headword ?? normalised);
        return;
      }
      const record = readRecord(cursor.value);
      // Same tiebreak as `readHistory`: the higher autoincrement `id` is the later search.
      if (!latest || record.at > latest.at || (record.at === latest.at && (record.id ?? 0) > (latest.id ?? 0))) {
        latest = record;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Every search for a lemma and all its forms: the union by `id` of the rows
 * whose `headword` is the key and those whose `normalised` is, each read with
 * its own cursor bounded to that key.
 */
export async function readLemmaHistory(
  key: string,
  limit?: number,
): Promise<{ rows: WordHistoryRow[]; total: number }> {
  return readHistory([HEADWORD_INDEX, NORMALISED_INDEX], key, limit);
}

async function readHistory(
  indexes: string[],
  key: string,
  limit: number | undefined,
): Promise<{ rows: WordHistoryRow[]; total: number }> {
  const database = await openLogDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const passes = await Promise.all(
    indexes.map(
      (index) =>
        new Promise<FoundRow[]>((resolve, reject) => {
          const request = store.index(index).openCursor(IDBKeyRange.only(key));
          const rows: FoundRow[] = [];
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(rows);
              return;
            }
            const record = readRecord(cursor.value);
            rows.push({
              id: record.id as number,
              at: record.at,
              text: record.text,
              outcome: record.outcome,
              translation: record.translation,
              definition: record.definition!,
              exampleEn: record.exampleEn!,
              exampleEs: record.exampleEs!,
              kind: record.kind,
            });
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        }),
    ),
  );
  const byId = new Map<number, FoundRow>();
  for (const row of passes.flat()) byId.set(row.id, row);
  const found = [...byId.values()];
  // Same tiebreak as `foldRow` above: the autoincrement `id` orders two
  // searches that landed in the same millisecond.
  found.sort((a, b) => b.at - a.at || b.id - a.id);
  const sliced = limit === undefined ? found : found.slice(0, limit);
  return {
    rows: sliced.map((row) => ({
      at: row.at,
      text: row.text,
      outcome: row.outcome,
      translation: row.translation,
      definition: row.definition,
      exampleEn: row.exampleEn,
      exampleEs: row.exampleEs,
      kind: row.kind,
    })),
    total: found.length,
  };
}
