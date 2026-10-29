// Raw IndexedDB, promisified here — no wrapper. The device holds exactly one
// dictionary: two object stores, one row each, and readiness is defined by
// `readInstalled` alone (RL-13). Nothing else in the app may open this
// database directly.
import { PAYLOAD_VERSION, type DictionaryManifest, type DictionaryPayload } from "./format";

const DB_NAME = "reading-dictionary";
const DB_VERSION = 1;
const PAYLOAD_STORE = "payload";
const META_STORE = "meta";
const PAYLOAD_KEY = "current";
const MANIFEST_KEY = "manifest";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) {
        db.createObjectStore(PAYLOAD_STORE);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

export async function clearInstalled(): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([PAYLOAD_STORE, META_STORE], "readwrite");
    tx.objectStore(PAYLOAD_STORE).clear();
    tx.objectStore(META_STORE).clear();
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

// One transaction, manifest last: a tab closed before this settles has
// committed neither row, so a reader never sees a payload without its
// manifest or a manifest without its payload.
export async function writeInstalled(manifest: DictionaryManifest, payloadText: string): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([PAYLOAD_STORE, META_STORE], "readwrite");
    tx.objectStore(PAYLOAD_STORE).put(payloadText, PAYLOAD_KEY);
    tx.objectStore(META_STORE).put(manifest, MANIFEST_KEY);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Absent, whole or an error — never a fourth. Anything short of "whole" is
// treated as absent and swept away so the next open starts clean.
export async function readInstalled(): Promise<{ manifest: DictionaryManifest; payload: DictionaryPayload } | null> {
  const db = await openDatabase();
  let manifest: unknown;
  let payloadText: unknown;
  try {
    const tx = db.transaction([PAYLOAD_STORE, META_STORE], "readonly");
    const manifestRequest = tx.objectStore(META_STORE).get(MANIFEST_KEY);
    const payloadRequest = tx.objectStore(PAYLOAD_STORE).get(PAYLOAD_KEY);
    [manifest, payloadText] = await Promise.all([
      requestToPromise(manifestRequest),
      requestToPromise(payloadRequest),
    ]);
    await transactionDone(tx);
  } finally {
    db.close();
  }

  const whole =
    manifest !== undefined &&
    manifest !== null &&
    typeof manifest === "object" &&
    (manifest as DictionaryManifest).payloadVersion === PAYLOAD_VERSION &&
    typeof payloadText === "string" &&
    byteLength(payloadText) === (manifest as DictionaryManifest).asset.bytes;

  if (!whole) {
    await clearInstalled();
    return null;
  }

  try {
    const payload = JSON.parse(payloadText as string) as DictionaryPayload;
    return { manifest: manifest as DictionaryManifest, payload };
  } catch {
    await clearInstalled();
    return null;
  }
}
