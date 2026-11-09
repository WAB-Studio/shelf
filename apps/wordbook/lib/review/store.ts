import type { ReviewCard } from "./schedule";

// RL-68's cards live in a database of their own, beside `reading-log`: the record's schema never
// moves for them, and a card is device state the copy (RL-22) does not carry. The sense the reader
// tapped to learn (RL-85) sits in a second store of the same database, keyed like the card.
const DATABASE_NAME = "reading-review";
const DATABASE_VERSION = 2;
const STORE_NAME = "cards";
const SENSE_STORE_NAME = "senses";

// RL-85: which sense of a word the card draws. A sense is named by its part of speech and its first
// translation, which the dictionary's order keeps stable; a name no sense answers to falls back to the first.
export type SenseChoice = { key: string; pos: string; translation: string };

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

// Both stores in one transaction, so a card and its sense leave together.
function write(apply: (cards: IDBObjectStore, senses: IDBObjectStore) => void): Promise<void> {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NAME, SENSE_STORE_NAME], "readwrite");
        apply(transaction.objectStore(STORE_NAME), transaction.objectStore(SENSE_STORE_NAME));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

// A word the reader removes from the record leaves the review with it: its schedule is the word's too.
export function deleteCard(key: string): Promise<void> {
  return write((cards, senses) => {
    cards.delete(key);
    senses.delete(key);
  });
}

export function clearCards(): Promise<void> {
  return write((cards, senses) => {
    cards.clear();
    senses.clear();
  });
}

// Resolves once the write is committed, so the next word never shows before the last answer is kept.
export function saveCard(card: ReviewCard): Promise<void> {
  return write((cards) => {
    cards.put(card);
  });
}

// RL-85: the reader's tap on a sense of the answer; a later tap replaces it.
export function saveSenseChoice(choice: SenseChoice): Promise<void> {
  return write((_cards, senses) => {
    senses.put(choice);
  });
}
