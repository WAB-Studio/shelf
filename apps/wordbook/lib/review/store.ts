import type { ReviewCard } from "./schedule";

// RL-68's cards live in a database of their own, beside `reading-log`: the record's schema never
// moves for them, and a card is device state the copy (RL-22) does not carry yet.
const DATABASE_NAME = "reading-review";
const DATABASE_VERSION = 1;
const STORE_NAME = "cards";

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB unavailable"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
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

function write(apply: (store: IDBObjectStore) => void): Promise<void> {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        apply(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

// A word the reader removes from the record leaves the review with it: its schedule is the word's too.
export function deleteCard(key: string): Promise<void> {
  return write((store) => store.delete(key));
}

export function clearCards(): Promise<void> {
  return write((store) => store.clear());
}

// Resolves once the write is committed, so the next word never shows before the last answer is kept.
export function saveCard(card: ReviewCard): Promise<void> {
  return write((store) => store.put(card));
}
