import { translateOverNetwork } from "@/lib/translate/network";
import { UNLISTED_ENDPOINT, unlistedRequestSchema, unlistedResponseSchema } from "@/lib/word/unlisted-protocol";
import { isPendingLookup } from "./outcome";
import { LOG_FLUSHED_EVENT, openLogDatabase, readAll } from "./record";
import { pendingRowFrom } from "./record-text";
import { cutTranslation } from "./translation-line";
import type { LookupRecord } from "./types";

// RL-76's drain: each pending row asked again once the network is back, at
// most once a local day, and replaced by the answered row it earns. The
// routes claim the paid call under their own daily caps; nothing here counts.

const STORE_NAME = "lookups";

// Every tab drains under this one name, so two tabs never pay for one row twice.
export const ANSWER_PENDING_LOCK = "voyager-answer-pending";

type Answer = Pick<
  LookupRecord,
  "outcome" | "headword" | "rule" | "senses" | "translation" | "origin" | "definition" | "exampleEn" | "exampleEs"
>;

function localDay(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const settleKey = (row: LookupRecord) => `${row.at}|${row.normalised}`;

// The same request and the same answer the search screen records for the
// same lookup: `unlisted` with its definition, or `translated` with its origin.
async function ask(row: LookupRecord): Promise<Answer | null> {
  try {
    if (row.kind === "word") {
      const body = unlistedRequestSchema.safeParse({ word: row.normalised });
      if (!body.success) return null;
      const response = await fetch(UNLISTED_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body.data),
      });
      if (response.status !== 200) return null;
      const parsed = unlistedResponseSchema.safeParse(await response.json());
      if (!parsed.success) return null;
      return {
        outcome: "unlisted",
        headword: row.normalised,
        rule: null,
        senses: 0,
        translation: cutTranslation(parsed.data.translations.join(", ")),
        origin: null,
        definition: parsed.data.definition,
        exampleEn: parsed.data.example.en,
        exampleEs: parsed.data.example.es,
      };
    }
    const result = await translateOverNetwork(row.text);
    if (typeof result?.text !== "string" || result.text.length === 0) return null;
    return {
      outcome: "translated",
      headword: null,
      rule: null,
      senses: 0,
      translation: cutTranslation(result.text),
      origin: result.origin,
    };
  } catch {
    return null;
  }
}

// One `readwrite` transaction on `lookups`; `change` decides from the row as
// that transaction reads it, so a row deleted meanwhile is left gone.
async function rewrite(
  id: number,
  change: (store: IDBObjectStore, current: LookupRecord) => void,
): Promise<boolean> {
  const database = await openLogDatabase();
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let changed = false;
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LookupRecord | undefined;
      if (!current || !isPendingLookup(current)) return;
      change(store, current);
      changed = true;
    };
    transaction.oncomplete = () => resolve(changed);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// The answered row is added, never put over the pending one: a new `id`
// lies past the upload cursor that already stepped over the pending row.
function replace(id: number, answer: Answer): Promise<boolean> {
  return rewrite(id, (store, current) => {
    const { id: oldId, askedOn, ...kept } = current;
    void oldId;
    void askedOn;
    store.delete(id);
    store.add(pendingRowFrom({ ...kept, ...answer }));
  });
}

function stamp(id: number, day: string): Promise<boolean> {
  return rewrite(id, (store, current) => {
    store.put({ ...current, askedOn: day });
  });
}

// The search screen's own answer, landed after its miss was already written,
// leaves a twin with the same moment: the pending one goes, unasked.
function dropTwin(id: number): Promise<boolean> {
  return rewrite(id, (store) => {
    store.delete(id);
  });
}

async function drain(now: number): Promise<void> {
  const today = localDay(now);
  const rows = await readAll();
  const answered = new Set(rows.filter((row) => row.device == null && !isPendingLookup(row)).map(settleKey));
  const waiting = rows.filter((row) => isPendingLookup(row) && row.askedOn !== today);
  let changed = false;
  for (const row of waiting) {
    if (answered.has(settleKey(row))) {
      changed = (await dropTwin(row.id!)) || changed;
      continue;
    }
    const answer = await ask(row);
    // A 204 or a failure says the network cannot answer yet: the rest of the
    // round would be refused the same way, and paid for if it were not.
    if (!answer) {
      await stamp(row.id!, today);
      break;
    }
    changed = (await replace(row.id!, answer)) || changed;
  }
  if (changed && typeof window !== "undefined") window.dispatchEvent(new Event(LOG_FLUSHED_EVENT));
}

/**
 * Asks every pending row not yet asked today, in the order recorded, and replaces each
 * one answered (RL-76). Offline it asks nothing. Never throws: a round that
 * fails leaves the rows pending for the next.
 */
export async function answerPending({ online, now }: { online: boolean; now: number }): Promise<void> {
  if (!online) return;
  try {
    if (typeof navigator === "undefined" || !navigator.locks) return await drain(now);
    await navigator.locks.request(ANSWER_PENDING_LOCK, () => drain(now));
  } catch {
    // The next `online` starts another round.
  }
}
