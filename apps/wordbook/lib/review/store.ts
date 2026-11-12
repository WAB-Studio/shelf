import { cardOf, choiceOf, entryOf, settle, type LocalHalves, type ReviewEntry } from "./entries";
import type { ReviewCard } from "./schedule";

// RL-68's cards live in a database of their own, beside `reading-log`: the record's schema never
// moves for them. The sense the reader tapped to learn (RL-85) sits in a second store of the same
// database, keyed like the card. Both travel with the account (RL-93): a third store keeps the mark of
// a word deleted, until a later review of it, and a fourth the copy's own cursors.
const DATABASE_NAME = "reading-review";
const DATABASE_VERSION = 3;
const STORE_NAME = "cards";
const SENSE_STORE_NAME = "senses";
const GONE_STORE_NAME = "gone";
const META_STORE_NAME = "meta";
const SYNC_KEY = "sync";

// RL-85: which sense of a word the card draws. A sense is named by its place in the group and by its
// signature (part of speech, every translation and the gloss), so two senses sharing a part of speech and a
// first translation stay apart; a name no sense answers to falls back to the first.
// `chosenAt` is the tap's moment, which orders it against another device's (RL-93); a tap kept before it was recorded has none.
export type SenseChoice = { key: string; index: number; signature: string; chosenAt?: number };

// A word deleted from the record, at the moment it was.
type Gone = { key: string; at: number };

// The review's own copy state: the reader it runs for, the newest version already sent and the
// server's cursor already merged in. `-1` sends everything.
export type ReviewSyncState = { readerId: string | null; pushedThrough: number; cursor: string | null };

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB unavailable"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const names = request.result.objectStoreNames;
      if (!names.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      if (!names.contains(SENSE_STORE_NAME)) request.result.createObjectStore(SENSE_STORE_NAME, { keyPath: "key" });
      if (!names.contains(GONE_STORE_NAME)) request.result.createObjectStore(GONE_STORE_NAME, { keyPath: "key" });
      if (!names.contains(META_STORE_NAME)) request.result.createObjectStore(META_STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onclose = () => {
        databasePromise = null;
      };
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    // Another tab holds an older version open: fail rather than leave the review loading forever.
    request.onblocked = () => reject(new Error("reading-review blocked"));
  });
  databasePromise.catch(() => {
    databasePromise = null;
  });
  return databasePromise;
}

export async function readCards(): Promise<ReviewCard[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as ReviewCard[]);
    request.onerror = () => reject(request.error);
  });
}

export async function readSenseChoice(key: string): Promise<SenseChoice | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(SENSE_STORE_NAME, "readonly").objectStore(SENSE_STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as SenseChoice | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

type Stores = { cards: IDBObjectStore; senses: IDBObjectStore; gone: IDBObjectStore; meta: IDBObjectStore };

// Every store in one transaction, so a card, its sense and its deletion mark leave together.
function write<T = void>(apply: (stores: Stores) => T | Promise<T>): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const names = [STORE_NAME, SENSE_STORE_NAME, GONE_STORE_NAME, META_STORE_NAME];
        const transaction = database.transaction(names, "readwrite");
        const [cards, senses, gone, meta] = names.map((name) => transaction.objectStore(name));
        let result: T;
        Promise.resolve(apply({ cards, senses, gone, meta })).then(
          (value) => {
            result = value;
          },
          (error: unknown) => {
            transaction.abort();
            reject(error);
          },
        );
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// A word the reader removes from the record leaves the review with it: its schedule is the word's too. The
// mark it leaves is what takes the card out of the account's copy (RL-93) and keeps an older one from returning.
export function deleteCard(key: string): Promise<void> {
  return write(({ cards, senses, gone }) => {
    cards.delete(key);
    senses.delete(key);
    gone.put({ key, at: Date.now() } satisfies Gone);
  });
}

// «Vaciar» on this device: the account's copy stands, so no deletion is marked.
export function clearCards(): Promise<void> {
  return write(({ cards, senses }) => {
    cards.clear();
    senses.clear();
  });
}

// Resolves once the write is committed, so the next word never shows before the last answer is kept.
export function saveCard(card: ReviewCard): Promise<void> {
  return write(({ cards, gone }) => {
    cards.put(card);
    gone.delete(card.key);
  });
}

// RL-85: the reader's tap on a sense of the answer; a later tap replaces it.
export function saveSenseChoice(choice: SenseChoice): Promise<void> {
  return write(({ senses, gone }) => {
    senses.put({ ...choice, chosenAt: Date.now() } satisfies SenseChoice);
    gone.delete(choice.key);
  });
}

export async function readSenseChoices(): Promise<SenseChoice[]> {
  const database = await openDatabase();
  return asPromise(database.transaction(SENSE_STORE_NAME, "readonly").objectStore(SENSE_STORE_NAME).getAll() as IDBRequest<SenseChoice[]>);
}

// RL-93: every word's version, as the account's copy orders them.
export async function readEntries(): Promise<ReviewEntry[]> {
  const database = await openDatabase();
  const transaction = database.transaction([STORE_NAME, SENSE_STORE_NAME, GONE_STORE_NAME], "readonly");
  const [cards, choices, gone] = await Promise.all([
    asPromise(transaction.objectStore(STORE_NAME).getAll() as IDBRequest<ReviewCard[]>),
    asPromise(transaction.objectStore(SENSE_STORE_NAME).getAll() as IDBRequest<SenseChoice[]>),
    asPromise(transaction.objectStore(GONE_STORE_NAME).getAll() as IDBRequest<Gone[]>),
  ]);
  const halves = new Map<string, LocalHalves>();
  const of = (key: string) => halves.get(key) ?? halves.set(key, { card: null, choice: null, goneAt: null }).get(key)!;
  for (const card of cards) of(card.key).card = card;
  for (const choice of choices) of(choice.key).choice = choice;
  for (const mark of gone) of(mark.key).goneAt = mark.at;
  return [...halves].flatMap(([key, half]) => entryOf(key, half) ?? []);
}

/**
 * Merges the versions the account sent down (RL-93), in one transaction: a version later than the device's own
 * replaces it, a deletion removes the card and the sense, and the rest is left alone. Resolves with how many
 * entries changed the device.
 */
export function applyEntries(remote: ReviewEntry[]): Promise<number> {
  return write(async ({ cards, senses, gone }) => {
    let changed = 0;
    for (const entry of remote) {
      const [card, choice, mark] = await Promise.all([
        asPromise(cards.get(entry.key) as IDBRequest<ReviewCard | undefined>),
        asPromise(senses.get(entry.key) as IDBRequest<SenseChoice | undefined>),
        asPromise(gone.get(entry.key) as IDBRequest<Gone | undefined>),
      ]);
      const next = settle(entryOf(entry.key, { card: card ?? null, choice: choice ?? null, goneAt: mark?.at ?? null }), entry);
      if (next === null) continue;
      changed += 1;
      gone.delete(entry.key);
      const nextCard = cardOf(next);
      const nextChoice = choiceOf(next);
      if (nextCard) cards.put(nextCard);
      else cards.delete(entry.key);
      if (nextChoice) senses.put(nextChoice);
      else senses.delete(entry.key);
    }
    return changed;
  });
}

export async function readReviewSync(): Promise<ReviewSyncState> {
  const database = await openDatabase();
  const stored = await asPromise(database.transaction(META_STORE_NAME, "readonly").objectStore(META_STORE_NAME).get(SYNC_KEY));
  return { readerId: stored?.readerId ?? null, pushedThrough: stored?.pushedThrough ?? -1, cursor: stored?.cursor ?? null };
}

export function writeReviewSync(state: ReviewSyncState): Promise<void> {
  return write(({ meta }) => {
    meta.put({ key: SYNC_KEY, ...state });
  });
}

// RL-93, as RL-73 says for the record: a device that last copied for another reader sends the new one only what it
// reviews after this moment, so what it already holds starts below the line.
export async function startReviewCopyFor(readerId: string): Promise<void> {
  const entries = await readEntries();
  await writeReviewSync({ readerId, pushedThrough: entries.reduce((latest, entry) => Math.max(latest, entry.at), -1), cursor: null });
}
