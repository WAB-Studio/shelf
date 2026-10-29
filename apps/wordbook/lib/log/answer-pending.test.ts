// RL-76's drain: a pending row is asked once a day when the network returns,
// under one lock across tabs, and on an answer becomes a new answered row
// with the same moment, in one transaction. Node has no IndexedDB, so a small
// in-memory one stands in below; `record.ts`, `merge.ts` and `delete.ts` run
// over it unmocked. No request leaves the process: `fetch` is a stub.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { LookupRecord } from "./types";

// --- An in-memory IndexedDB: keys, ranges, stores, indexes, cursors, one transaction at a time ---

type Key = number | string | Key[];

function isKey(value: unknown): value is Key {
  if (typeof value === "number") return !Number.isNaN(value);
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isKey);
  return false;
}

function rank(key: Key): number {
  return typeof key === "number" ? 0 : typeof key === "string" ? 1 : 2;
}

function compareKeys(a: Key, b: Key): number {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

class FakeKeyRange {
  constructor(
    readonly lower: Key | undefined,
    readonly upper: Key | undefined,
    readonly lowerOpen = false,
    readonly upperOpen = false,
  ) {}
  includes(key: Key): boolean {
    if (this.lower !== undefined) {
      const c = compareKeys(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = compareKeys(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
  static only(key: Key) {
    return new FakeKeyRange(key, key);
  }
  static lowerBound(key: Key, open = false) {
    return new FakeKeyRange(key, undefined, open, false);
  }
  static upperBound(key: Key, open = false) {
    return new FakeKeyRange(undefined, key, false, open);
  }
  static bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

function asRange(query: unknown): FakeKeyRange | null {
  if (query === undefined || query === null) return null;
  if (query instanceof FakeKeyRange) return query;
  if (isKey(query)) return FakeKeyRange.only(query);
  throw domError("DataError");
}

function keyAt(value: unknown, path: string | string[]): unknown {
  if (Array.isArray(path)) return path.map((part) => keyAt(value, part));
  return path
    .split(".")
    .reduce<unknown>((at, part) => (at == null ? undefined : (at as Record<string, unknown>)[part]), value);
}

type Entry = { key: Key; primaryKey: Key; value: unknown };
type IndexDef = { keyPath: string | string[]; unique: boolean };
type StoreData = {
  keyPath: string | null;
  autoIncrement: boolean;
  next: number;
  records: { key: Key; value: unknown }[];
  indexes: Map<string, IndexDef>;
};
type DatabaseData = { version: number; stores: Map<string, StoreData> };

const databases = new Map<string, DatabaseData>();

function storeEntries(store: StoreData): Entry[] {
  return store.records.map((record) => ({ key: record.key, primaryKey: record.key, value: record.value }));
}

function indexEntries(store: StoreData, index: IndexDef): Entry[] {
  const entries: Entry[] = [];
  for (const record of store.records) {
    const key = keyAt(record.value, index.keyPath);
    if (isKey(key)) entries.push({ key, primaryKey: record.key, value: record.value });
  }
  return entries.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.primaryKey, b.primaryKey));
}

type Listener = (event: unknown) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown): void {
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === "function") handler.call(this, event);
    for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
  }
}

class FakeRequest extends Emitter {
  result: unknown = undefined;
  error: Error | null = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: Listener | null = null;
  onerror: Listener | null = null;
  onupgradeneeded: Listener | null = null;
  onblocked: Listener | null = null;
  transaction: FakeTransaction | null = null;
  constructor(readonly source: unknown = null) {
    super();
  }
}

// Every transaction waits for the one before it to finish: stricter than
// IndexedDB's scope rule, never looser.
const scheduled: FakeTransaction[] = [];
let runningTransaction: FakeTransaction | null = null;

function startNext(): void {
  if (runningTransaction) return;
  const next = scheduled.shift();
  if (!next) return;
  runningTransaction = next;
  setImmediate(() => next.start());
}

// Called with the store's rows after every committed `readwrite` transaction.
let onCommit: ((rows: LookupRecord[]) => void) | null = null;

class FakeTransaction extends Emitter {
  state: "waiting" | "active" | "finished" = "waiting";
  error: Error | null = null;
  oncomplete: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;
  private queue: (() => void)[] = [];
  private busy = false;
  private snapshot: Map<string, StoreData> | null = null;
  constructor(
    readonly database: FakeDatabase,
    readonly scope: string[] | null,
    readonly mode: string,
  ) {
    super();
  }
  get db() {
    return this.database;
  }
  get objectStoreNames() {
    return listOf(this.scope ?? [...this.database.data.stores.keys()]);
  }
  objectStore(name: string): FakeStore {
    if (this.state === "finished") throw domError("InvalidStateError");
    if ((this.scope && !this.scope.includes(name)) || !this.database.data.stores.has(name)) {
      throw domError("NotFoundError");
    }
    return new FakeStore(this, name);
  }
  enqueue(request: FakeRequest, run: () => unknown): FakeRequest {
    if (this.state === "finished") throw domError("TransactionInactiveError");
    request.transaction = this;
    request.readyState = "pending";
    this.queue.push(() => {
      let value: unknown;
      try {
        value = run();
      } catch (error) {
        request.readyState = "done";
        request.error = error as Error;
        let prevented = false;
        const event = { type: "error", target: request, preventDefault: () => (prevented = true) };
        request.emit("error", event);
        this.emit("error", event);
        if (!prevented) this.abort(error as Error);
        return;
      }
      request.readyState = "done";
      request.result = value;
      request.emit("success", { type: "success", target: request });
    });
    this.pump();
    return request;
  }
  start(): void {
    this.state = "active";
    this.snapshot = structuredClone(this.database.data.stores);
    this.pump();
  }
  private pump(): void {
    if (this.state !== "active" || this.busy) return;
    const op = this.queue.shift();
    if (!op) {
      setImmediate(() => {
        if (this.state === "active" && !this.busy && this.queue.length === 0) this.finish();
      });
      return;
    }
    this.busy = true;
    setImmediate(() => {
      if (this.state === "active") op();
      this.busy = false;
      this.pump();
    });
  }
  private finish(): void {
    this.state = "finished";
    if (this.mode !== "readonly" && onCommit) {
      const lookups = this.database.data.stores.get("lookups");
      if (lookups) onCommit(lookups.records.map((record) => structuredClone(record.value) as LookupRecord));
    }
    this.emit("complete", { type: "complete", target: this });
    runningTransaction = null;
    startNext();
  }
  abort(error: Error | null = null): void {
    if (this.state === "finished") throw domError("InvalidStateError");
    this.state = "finished";
    this.error = error ?? domError("AbortError");
    if (this.snapshot) this.database.data.stores = this.snapshot;
    setImmediate(() => {
      this.emit("abort", { type: "abort", target: this });
      if (runningTransaction === this) runningTransaction = null;
      else scheduled.splice(scheduled.indexOf(this), 1);
      startNext();
    });
  }
  commit(): void {}
}

function listOf(names: string[]) {
  return Object.assign([...names], { contains: (name: string) => names.includes(name), item: (i: number) => names[i] });
}

type Direction = "next" | "prev" | "nextunique" | "prevunique";

function openCursor(
  transaction: FakeTransaction,
  source: unknown,
  read: () => Entry[],
  query: unknown,
  direction: Direction,
  withValue: boolean,
  storeName: string,
): FakeRequest {
  const range = asRange(query);
  const request = new FakeRequest(source);
  let position: { key: Key; primaryKey: Key } | null = null;
  const backwards = direction.startsWith("prev");
  const step = (): unknown => {
    let entries = read().filter((entry) => !range || range.includes(entry.key));
    if (backwards) entries = entries.reverse();
    const found = entries.find((entry) => {
      if (!position) return true;
      const c = compareKeys(entry.key, position.key);
      if (direction.endsWith("unique")) return backwards ? c < 0 : c > 0;
      const p = compareKeys(entry.primaryKey, position.primaryKey);
      return backwards ? c < 0 || (c === 0 && p < 0) : c > 0 || (c === 0 && p > 0);
    });
    if (!found) return null;
    position = { key: found.key, primaryKey: found.primaryKey };
    const store = new FakeStore(transaction, storeName);
    return {
      key: found.key,
      primaryKey: found.primaryKey,
      direction,
      source,
      ...(withValue ? { value: structuredClone(found.value) } : {}),
      continue: () => transaction.enqueue(request, step),
      advance: (count: number) => {
        for (let i = 1; i < count; i++) step();
        transaction.enqueue(request, step);
      },
      delete: () => store.delete(found.primaryKey),
      update: (value: unknown) => store.put(value),
    };
  };
  return transaction.enqueue(request, step);
}

class FakeIndex {
  constructor(
    readonly transaction: FakeTransaction,
    readonly storeName: string,
    readonly name: string,
  ) {}
  private entries(): Entry[] {
    const store = this.transaction.database.data.stores.get(this.storeName)!;
    return indexEntries(store, store.indexes.get(this.name)!);
  }
  private matching(query: unknown): Entry[] {
    const range = asRange(query);
    return this.entries().filter((entry) => !range || range.includes(entry.key));
  }
  get(query: unknown) {
    return this.transaction.enqueue(new FakeRequest(this), () => {
      const found = this.matching(query)[0];
      return found ? structuredClone(found.value) : undefined;
    });
  }
  getKey(query: unknown) {
    return this.transaction.enqueue(new FakeRequest(this), () => this.matching(query)[0]?.primaryKey);
  }
  getAll(query?: unknown, count?: number) {
    return this.transaction.enqueue(new FakeRequest(this), () =>
      this.matching(query).slice(0, count || undefined).map((entry) => structuredClone(entry.value)),
    );
  }
  getAllKeys(query?: unknown, count?: number) {
    return this.transaction.enqueue(new FakeRequest(this), () =>
      this.matching(query).slice(0, count || undefined).map((entry) => entry.primaryKey),
    );
  }
  count(query?: unknown) {
    return this.transaction.enqueue(new FakeRequest(this), () => this.matching(query).length);
  }
  openCursor(query?: unknown, direction: Direction = "next") {
    return openCursor(this.transaction, this, () => this.entries(), query, direction, true, this.storeName);
  }
  openKeyCursor(query?: unknown, direction: Direction = "next") {
    return openCursor(this.transaction, this, () => this.entries(), query, direction, false, this.storeName);
  }
}

class FakeStore {
  constructor(
    readonly transaction: FakeTransaction,
    readonly name: string,
  ) {}
  private get data(): StoreData {
    return this.transaction.database.data.stores.get(this.name)!;
  }
  get keyPath() {
    return this.data.keyPath;
  }
  get autoIncrement() {
    return this.data.autoIncrement;
  }
  get indexNames() {
    return listOf([...this.data.indexes.keys()]);
  }
  private matching(query: unknown): Entry[] {
    const range = asRange(query);
    return storeEntries(this.data).filter((entry) => !range || range.includes(entry.key));
  }
  private write(value: unknown, explicitKey: unknown, overwrite: boolean) {
    if (this.transaction.mode === "readonly") throw domError("ReadOnlyError");
    const copy = structuredClone(value) as Record<string, unknown>;
    return this.transaction.enqueue(new FakeRequest(this), () => {
      const store = this.data;
      let key = store.keyPath ? keyAt(copy, store.keyPath) : explicitKey;
      if (key === undefined && store.autoIncrement) {
        key = store.next;
        if (store.keyPath) copy[store.keyPath] = key;
      }
      if (!isKey(key)) throw domError("DataError");
      if (typeof key === "number" && store.autoIncrement && key >= store.next) store.next = Math.floor(key) + 1;
      const at = store.records.findIndex((record) => compareKeys(record.key, key as Key) === 0);
      if (at >= 0 && !overwrite) throw domError("ConstraintError");
      for (const index of store.indexes.values()) {
        if (!index.unique) continue;
        const indexKey = keyAt(copy, index.keyPath);
        if (!isKey(indexKey)) continue;
        const clash = store.records.some(
          (record) =>
            compareKeys(record.key, key as Key) !== 0 &&
            isKey(keyAt(record.value, index.keyPath)) &&
            compareKeys(keyAt(record.value, index.keyPath) as Key, indexKey) === 0,
        );
        if (clash) throw domError("ConstraintError");
      }
      if (at >= 0) store.records[at] = { key, value: copy };
      else {
        store.records.push({ key, value: copy });
        store.records.sort((a, b) => compareKeys(a.key, b.key));
      }
      return key;
    });
  }
  add(value: unknown, key?: unknown) {
    return this.write(value, key, false);
  }
  put(value: unknown, key?: unknown) {
    return this.write(value, key, true);
  }
  get(query: unknown) {
    return this.transaction.enqueue(new FakeRequest(this), () => {
      const found = this.matching(query)[0];
      return found ? structuredClone(found.value) : undefined;
    });
  }
  getKey(query: unknown) {
    return this.transaction.enqueue(new FakeRequest(this), () => this.matching(query)[0]?.key);
  }
  getAll(query?: unknown, count?: number) {
    return this.transaction.enqueue(new FakeRequest(this), () =>
      this.matching(query).slice(0, count || undefined).map((entry) => structuredClone(entry.value)),
    );
  }
  getAllKeys(query?: unknown, count?: number) {
    return this.transaction.enqueue(new FakeRequest(this), () =>
      this.matching(query).slice(0, count || undefined).map((entry) => entry.key),
    );
  }
  count(query?: unknown) {
    return this.transaction.enqueue(new FakeRequest(this), () => this.matching(query).length);
  }
  delete(query: unknown) {
    if (this.transaction.mode === "readonly") throw domError("ReadOnlyError");
    return this.transaction.enqueue(new FakeRequest(this), () => {
      const range = asRange(query)!;
      this.data.records = this.data.records.filter((record) => !range.includes(record.key));
      return undefined;
    });
  }
  clear() {
    if (this.transaction.mode === "readonly") throw domError("ReadOnlyError");
    return this.transaction.enqueue(new FakeRequest(this), () => {
      this.data.records = [];
      return undefined;
    });
  }
  index(name: string) {
    if (!this.data.indexes.has(name)) throw domError("NotFoundError");
    return new FakeIndex(this.transaction, this.name, name);
  }
  createIndex(name: string, keyPath: string | string[], options: { unique?: boolean } = {}) {
    if (this.transaction.mode !== "versionchange") throw domError("InvalidStateError");
    this.data.indexes.set(name, { keyPath, unique: !!options.unique });
    return new FakeIndex(this.transaction, this.name, name);
  }
  deleteIndex(name: string) {
    this.data.indexes.delete(name);
  }
  openCursor(query?: unknown, direction: Direction = "next") {
    return openCursor(this.transaction, this, () => storeEntries(this.data), query, direction, true, this.name);
  }
  openKeyCursor(query?: unknown, direction: Direction = "next") {
    return openCursor(this.transaction, this, () => storeEntries(this.data), query, direction, false, this.name);
  }
}

class FakeDatabase extends Emitter {
  onversionchange: Listener | null = null;
  onclose: Listener | null = null;
  upgrade: FakeTransaction | null = null;
  constructor(
    readonly name: string,
    readonly data: DatabaseData,
  ) {
    super();
  }
  get version() {
    return this.data.version;
  }
  get objectStoreNames() {
    return listOf([...this.data.stores.keys()]);
  }
  createObjectStore(name: string, options: { keyPath?: string | null; autoIncrement?: boolean } = {}) {
    if (!this.upgrade) throw domError("InvalidStateError");
    this.data.stores.set(name, {
      keyPath: options.keyPath ?? null,
      autoIncrement: !!options.autoIncrement,
      next: 1,
      records: [],
      indexes: new Map(),
    });
    return new FakeStore(this.upgrade, name);
  }
  deleteObjectStore(name: string) {
    this.data.stores.delete(name);
  }
  transaction(names: string | string[], mode: string = "readonly") {
    const scope = typeof names === "string" ? [names] : [...names];
    for (const name of scope) if (!this.data.stores.has(name)) throw domError("NotFoundError");
    const transaction = new FakeTransaction(this, scope, mode);
    scheduled.push(transaction);
    startNext();
    return transaction;
  }
  close() {}
}

const fakeIndexedDB = {
  open(name: string, version?: number) {
    const request = new FakeRequest();
    setImmediate(() => {
      if (!databases.has(name)) databases.set(name, { version: 0, stores: new Map() });
      const data = databases.get(name)!;
      const connection = new FakeDatabase(name, data);
      const wanted = version ?? Math.max(1, data.version);
      request.result = connection;
      if (wanted < data.version) {
        request.error = domError("VersionError");
        request.emit("error", { type: "error", target: request, preventDefault() {} });
        return;
      }
      if (wanted === data.version) {
        request.readyState = "done";
        request.emit("success", { type: "success", target: request });
        return;
      }
      const oldVersion = data.version;
      const upgrade = new FakeTransaction(connection, null, "versionchange");
      connection.upgrade = upgrade;
      request.transaction = upgrade;
      upgrade.addEventListener("complete", () => {
        connection.upgrade = null;
        request.transaction = null;
        request.readyState = "done";
        request.emit("success", { type: "success", target: request });
      });
      scheduled.unshift(upgrade);
      const begin = upgrade.start.bind(upgrade);
      upgrade.start = () => {
        data.version = wanted;
        begin();
        request.emit("upgradeneeded", { type: "upgradeneeded", target: request, oldVersion, newVersion: wanted });
      };
      startNext();
    });
    return request;
  },
  deleteDatabase(name: string) {
    databases.delete(name);
    const request = new FakeRequest();
    setImmediate(() => request.emit("success", { type: "success", target: request }));
    return request;
  },
};

// --- The rest of the browser the drain touches: storage relay, window events, Web Locks, fetch ---

const relay = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => (relay.has(key) ? relay.get(key)! : null),
  setItem: (key: string, value: string) => void relay.set(key, String(value)),
  removeItem: (key: string) => void relay.delete(key),
  clear: () => relay.clear(),
  key: (i: number) => [...relay.keys()][i] ?? null,
  get length() {
    return relay.size;
  },
};

// Every `navigator.locks.request` the code makes, by name, and an exclusive
// queue per name: the second holder waits for the first, as across tabs.
const lockNames: string[] = [];
const lockTails = new Map<string, Promise<unknown>>();
const lockHeld = new Map<string, number>();
const fakeLocks = {
  request(name: string, second: unknown, third?: unknown) {
    const callback = (typeof second === "function" ? second : third) as (lock: unknown) => unknown;
    const options = (typeof second === "function" ? {} : (second ?? {})) as { ifAvailable?: boolean };
    lockNames.push(name);
    if (options.ifAvailable && (lockHeld.get(name) ?? 0) > 0) return Promise.resolve().then(() => callback(null));
    const run = (lockTails.get(name) ?? Promise.resolve()).then(async () => {
      lockHeld.set(name, (lockHeld.get(name) ?? 0) + 1);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        lockHeld.set(name, lockHeld.get(name)! - 1);
      }
    });
    lockTails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  },
  query: async () => ({ held: [], pending: [] }),
};

type Asked = { url: string; body: Record<string, unknown> | null };
let asked: Asked[] = [];
let respond: (call: Asked) => Promise<Response> | Response = () => new Response(null, { status: 204 });

// Answers a macrotask later, so no transaction opened before the request is
// still alive when the answer lands — as on a real network.
const fakeFetch = async (input: unknown, init?: { body?: unknown }) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url);
  const call: Asked = { url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
  asked.push(call);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return respond(call);
};

const windowEvents = new EventTarget();

const globals = globalThis as unknown as Record<string, unknown>;
globals.indexedDB = fakeIndexedDB;
globals.IDBKeyRange = FakeKeyRange;
globals.localStorage = fakeLocalStorage;
globals.window = windowEvents;
globals.fetch = fakeFetch;
Object.defineProperty(globalThis.navigator, "locks", { value: fakeLocks, configurable: true });
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

type Modules = {
  drain: typeof import("./answer-pending");
  record: typeof import("./record");
  merge: typeof import("./merge");
  remove: typeof import("./delete");
};
let modules: Modules | null = null;

// Imported lazily: the globals above must exist before `record.ts` loads.
async function load(): Promise<Modules> {
  if (modules) return modules;
  const [drain, record, merge, remove] = await Promise.all([
    import("./answer-pending"),
    import("./record"),
    import("./merge"),
    import("./delete"),
  ]);
  await record.openLogDatabase();
  modules = { drain, record, merge, remove };
  return modules;
}

// A second tab: its own copy of the drain module, the same database.
async function loadSecondTab(): Promise<typeof import("./answer-pending")> {
  return (await import("./answer-pending?tab=second" as string)) as typeof import("./answer-pending");
}

function lookupsStore(): StoreData {
  return databases.get("reading-log")!.stores.get("lookups")!;
}

function stored(): (LookupRecord & { askedOn?: unknown })[] {
  return lookupsStore().records.map((record) => structuredClone(record.value) as LookupRecord & { askedOn?: unknown });
}

// Straight into the store, the way a row this device recorded earlier sits there.
function seed(row: LookupRecord): number {
  const store = lookupsStore();
  const id = store.next++;
  store.records.push({ key: id, value: { ...structuredClone(row), id } });
  store.records.sort((a, b) => compareKeys(a.key, b.key));
  return id;
}

const NOON = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function pendingWord(text: string, at = NOON - 3 * 60 * 60 * 1000): LookupRecord {
  return {
    schema: 4,
    at,
    text,
    normalised: text.toLowerCase(),
    kind: "word",
    outcome: "miss",
    headword: null,
    rule: null,
    senses: 0,
    translation: null,
    dictionaryReady: true,
    origin: null,
  };
}

function pendingPhrase(text: string, at = NOON - 2 * 60 * 60 * 1000): LookupRecord {
  return { ...pendingWord(text, at), kind: "phrase", outcome: "untranslated", normalised: text.toLowerCase() };
}

function answeredWord(text: string, at = NOON - 4 * 60 * 60 * 1000): LookupRecord {
  return {
    ...pendingWord(text, at),
    outcome: "exact",
    headword: text,
    senses: 1,
    translation: `t-${text}`,
  };
}

const UNLISTED = {
  translations: ["zorpo", "zorpa"],
  definition: "a word no dictionary carries",
  example: { en: "A zorp sat there.", es: "Un zorpo estaba ahí." },
  lemma: null,
  rule: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function answerEverything(call: Asked): Response {
  if (call.url.endsWith("/api/word/unlisted")) return json(UNLISTED);
  if (call.url.endsWith("/api/translate")) return json({ text: "el gato se sentó", origin: "network" });
  return new Response(null, { status: 404 });
}

beforeEach(async () => {
  await load();
  lookupsStore().records = [];
  asked = [];
  lockNames.length = 0;
  onCommit = null;
  respond = answerEverything;
});

// --- Answer replaces, Uploaded after ---

test("respuesta: un 200 deja una fila «unlisted» con el mismo momento y texto, y ninguna pendiente", async () => {
  const { drain } = await load();
  const original = pendingWord("Zorp");
  const pendingId = seed(original);
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  assert.ok(asked[0].url.endsWith("/api/word/unlisted"));
  assert.equal(asked[0].body?.word, "zorp");
  const rows = stored();
  assert.equal(rows.length, 1, "the pending row is replaced, not kept beside its answer");
  const [answered] = rows;
  assert.equal(answered.outcome, "unlisted");
  assert.equal(answered.kind, "word");
  assert.equal(answered.at, original.at);
  assert.equal(answered.text, original.text);
  assert.equal(answered.normalised, original.normalised);
  assert.equal(answered.device ?? null, null);
  assert.ok(answered.translation?.includes("zorpo"), `translation ${answered.translation}`);
  assert.notEqual(answered.id, pendingId);
});

test("respuesta: la fila respondida lleva un id nuevo, por encima del cursor que ya pasó la pendiente", async () => {
  const { drain, merge } = await load();
  seed(answeredWord("cat"));
  seed(pendingWord("zorp"));
  const before = await merge.readSince(0, 100);
  const cursor = before.scannedThrough!;
  await drain.answerPending({ online: true, now: NOON });
  const answered = stored().find((row) => row.normalised === "zorp")!;
  assert.equal(answered.outcome, "unlisted");
  assert.ok(answered.id! > cursor, `id ${answered.id} must lie past the cursor ${cursor}`);
});

test("subida: desde el cursor viejo, readSince devuelve la fila respondida", async () => {
  const { drain, merge } = await load();
  seed(answeredWord("cat"));
  seed(pendingWord("zorp"));
  const before = await merge.readSince(0, 100);
  assert.deepEqual(
    before.own.map((row) => row.normalised),
    ["cat"],
    "the pending row is not uploaded",
  );
  await drain.answerPending({ online: true, now: NOON });
  const after = await merge.readSince(before.scannedThrough!, 100);
  assert.deepEqual(
    after.own.map((row) => [row.normalised, row.outcome]),
    [["zorp", "unlisted"]],
  );
});

test("respuesta: una frase pendiente se pide a /api/translate y queda «translated»", async () => {
  const { drain } = await load();
  const original = pendingPhrase("The cat sat");
  seed(original);
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  assert.ok(asked[0].url.endsWith("/api/translate"));
  assert.equal(asked[0].body?.text, "The cat sat");
  const rows = stored();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "translated");
  assert.equal(rows[0].kind, "phrase");
  assert.equal(rows[0].at, original.at);
  assert.equal(rows[0].text, original.text);
  assert.equal(rows[0].translation, "el gato se sentó");
});

test("respuesta: ningún estado confirmado tiene la búsqueda dos veces ni ninguna vez", async () => {
  const { drain } = await load();
  seed(pendingWord("zorp"));
  const seen: number[] = [];
  onCommit = (rows) => seen.push(rows.filter((row) => row.normalised === "zorp").length);
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(stored()[0].outcome, "unlisted");
  assert.ok(seen.length > 0);
  assert.deepEqual(
    seen.filter((count) => count !== 1),
    [],
    `every committed state holds the lookup once; seen ${JSON.stringify(seen)}`,
  );
});

test("respuesta: avisa con LOG_FLUSHED_EVENT cuando una fila queda respondida", async () => {
  const { drain, record } = await load();
  seed(pendingWord("zorp"));
  let fired = 0;
  const listener = () => (fired += 1);
  windowEvents.addEventListener(record.LOG_FLUSHED_EVENT, listener);
  try {
    await drain.answerPending({ online: true, now: NOON });
  } finally {
    windowEvents.removeEventListener(record.LOG_FLUSHED_EVENT, listener);
  }
  assert.ok(fired >= 1);
});

// --- 204 keeps it, a failure keeps it, Once a day ---

test("204: la fila sigue pendiente con askedOn, y la ronda se detiene", async () => {
  const { drain } = await load();
  seed(pendingWord("zorp", NOON - 3000));
  seed(pendingWord("blick", NOON - 2000));
  respond = () => new Response(null, { status: 204 });
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1, "the round stops at the first 204");
  const rows = stored();
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ["miss", "miss"],
  );
  const stamped = rows.filter((row) => row.askedOn != null);
  assert.equal(stamped.length, 1, "only the row asked carries askedOn");
  assert.equal(stamped[0].normalised, asked[0].body?.word);
});

test("fallo de red: la fila sigue pendiente con askedOn", async () => {
  const { drain } = await load();
  seed(pendingWord("zorp"));
  respond = () => {
    throw new TypeError("Failed to fetch");
  };
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  const [row] = stored();
  assert.equal(row.outcome, "miss");
  assert.notEqual(row.askedOn ?? null, null);
});

test("una vez al día: el mismo día no se vuelve a pedir; al día siguiente sí", async () => {
  const { drain } = await load();
  seed(pendingWord("zorp"));
  respond = () => new Response(null, { status: 204 });
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  await drain.answerPending({ online: true, now: NOON + 60_000 });
  await drain.answerPending({ online: true, now: NOON + 5 * 60 * 60 * 1000 });
  assert.equal(asked.length, 1, "asked at most once the same day");
  await drain.answerPending({ online: true, now: NOON + DAY });
  assert.equal(asked.length, 2, "asked again the next day");
});

test("sin conexión: no pide nada", async () => {
  const { drain } = await load();
  seed(pendingWord("zorp"));
  await drain.answerPending({ online: false, now: NOON });
  assert.equal(asked.length, 0);
  assert.equal(stored()[0].outcome, "miss");
});

// --- Legacy never pending ---

test("legado: un «miss» de esquema 3 nunca se pide ni se toca", async () => {
  const { drain } = await load();
  seed({ ...pendingWord("zorp"), schema: 3 });
  seed({ ...pendingWord("old"), schema: 1 });
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 0);
  assert.deepEqual(
    stored().map((row) => [row.outcome, row.askedOn ?? null]),
    [
      ["miss", null],
      ["miss", null],
    ],
  );
});

test("ajena: un «miss» que bajó de otro dispositivo no se pide en este", async () => {
  const { drain } = await load();
  seed({ ...pendingWord("zorp"), device: "other-device", deviceSeq: 7 });
  seed(answeredWord("cat"));
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 0);
});

// --- Two tabs ---

test("dos pestañas a la vez: una sola petición por fila, y una sola fila respondida", async () => {
  const { drain } = await load();
  const second = await loadSecondTab();
  seed(pendingWord("zorp"));
  await Promise.all([
    drain.answerPending({ online: true, now: NOON }),
    second.answerPending({ online: true, now: NOON }),
  ]);
  assert.equal(asked.length, 1, `one request, saw ${asked.length}`);
  assert.deepEqual(
    stored().map((row) => row.outcome),
    ["unlisted"],
  );
  assert.ok(lockNames.includes("voyager-answer-pending"), `locks requested: ${JSON.stringify(lockNames)}`);
});

// --- Deleted while asked ---

test("borrada mientras se pedía: no vuelve", async () => {
  const { drain, remove } = await load();
  seed(pendingWord("zorp"));
  respond = async (call) => {
    await remove.deleteStudyGroup("zorp");
    return answerEverything(call);
  };
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  assert.deepEqual(stored(), []);
});

// --- The whole path: recorded offline, answered online ---

test("de punta a punta: una palabra sin entrada grabada sin red queda pendiente y luego respondida", async () => {
  const { drain, record } = await load();
  const landed = new Promise<void>((resolve) =>
    windowEvents.addEventListener(record.LOG_FLUSHED_EVENT, () => resolve(), { once: true }),
  );
  record.recordLookup({
    at: NOON - 1000,
    text: "zorp",
    normalised: "zorp",
    kind: "word",
    outcome: "miss",
    headword: null,
    rule: null,
    senses: 0,
    translation: null,
    dictionaryReady: true,
    origin: null,
  });
  record.flushPendingLookup();
  await Promise.race([landed, new Promise((_, reject) => setTimeout(() => reject(new Error("no row landed")), 2000))]);
  assert.deepEqual(
    stored().map((row) => row.outcome),
    ["miss"],
  );
  await drain.answerPending({ online: true, now: NOON });
  const rows = stored();
  assert.deepEqual(
    rows.map((row) => [row.outcome, row.at]),
    [["unlisted", NOON - 1000]],
  );
});

// --- M30: the guards of the drain and of the count, each driven by a row a reader could hold ---

test("fila ya respondida entre tanto: la respuesta de la red no la pisa (la pendiente no existe ya)", async () => {
  const { drain } = await load();
  const id = seed(pendingWord("zorp"));
  // The search screen's own answer lands while the drain's request is in flight.
  respond = async (call) => {
    const store = lookupsStore();
    const record = store.records.find((entry) => entry.key === id)!;
    record.value = { ...(record.value as LookupRecord), outcome: "unlisted", translation: "answered-by-screen" };
    return answerEverything(call);
  };
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  const rows = stored();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id, "the answered row keeps its id: nothing deleted and re-added");
  assert.equal(rows[0].translation, "answered-by-screen");
});

test("fila ya respondida entre tanto: un 204 tampoco le pone askedOn", async () => {
  const { drain } = await load();
  const id = seed(pendingWord("zorp"));
  respond = async () => {
    const record = lookupsStore().records.find((entry) => entry.key === id)!;
    record.value = { ...(record.value as LookupRecord), outcome: "unlisted", translation: "answered-by-screen" };
    return new Response(null, { status: 204 });
  };
  await drain.answerPending({ online: true, now: NOON });
  const [row] = stored();
  assert.equal(row.outcome, "unlisted");
  assert.equal(row.askedOn ?? null, null, "an answered row never carries askedOn");
});

test("gemela respondida: la pendiente con el mismo momento y texto se descarta sin pedir nada", async () => {
  const { drain } = await load();
  const at = NOON - 5000;
  seed({ ...pendingWord("zorp", at), outcome: "unlisted", translation: "zorpo" });
  seed(pendingWord("zorp", at));
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 0, "a twin already answered is not paid for");
  const rows = stored();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "unlisted");
});

test("gemela con otro momento: la pendiente se pide y las dos filas quedan", async () => {
  const { drain } = await load();
  seed({ ...pendingWord("zorp", NOON - 9000), outcome: "unlisted", translation: "zorpo" });
  seed(pendingWord("zorp", NOON - 5000));
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  assert.deepEqual(
    stored().map((row) => row.outcome),
    ["unlisted", "unlisted"],
  );
});

test("respuesta de otro dispositivo con el mismo momento y texto: no salda la pendiente de este", async () => {
  const { drain } = await load();
  const at = NOON - 5000;
  seed({ ...pendingWord("zorp", at), outcome: "unlisted", translation: "zorpo", device: "other-device", deviceSeq: 3 });
  seed(pendingWord("zorp", at));
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1, "only this device's own answered row settles its pending row");
  const own = stored().filter((row) => row.device == null);
  assert.deepEqual(
    own.map((row) => row.outcome),
    ["unlisted"],
  );
});

test("respondida: la fila nueva no lleva askedOn aunque la pendiente lo llevara", async () => {
  const { drain } = await load();
  seed({ ...pendingWord("zorp"), askedOn: "2026-10-17" });
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  const [row] = stored();
  assert.equal(row.outcome, "unlisted");
  assert.equal("askedOn" in row, false, `answered row carries askedOn ${JSON.stringify(row.askedOn)}`);
});

test("askedOn es el día local AAAA-MM-DD del momento de la ronda", async () => {
  const { drain } = await load();
  seed(pendingWord("zorp"));
  respond = () => new Response(null, { status: 204 });
  await drain.answerPending({ online: true, now: NOON });
  const [row] = stored();
  assert.equal(row.askedOn, new Date(NOON).toLocaleDateString("en-CA"));
});

test("frase: una traducción vacía de la red no responde la fila, que sigue pendiente", async () => {
  const { drain } = await load();
  seed(pendingPhrase("The cat sat"));
  respond = () => json({ text: "", origin: "network" });
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 1);
  const [row] = stored();
  assert.equal(row.outcome, "untranslated");
  assert.equal(row.translation, null);
  assert.notEqual(row.askedOn ?? null, null);
});

test("palabra que el protocolo no admite (más de 64 caracteres): no se envía nada y la ronda se detiene", async () => {
  const { drain } = await load();
  seed(pendingWord("z".repeat(65)));
  await drain.answerPending({ online: true, now: NOON });
  assert.equal(asked.length, 0, "a request the route would refuse is never sent");
  const [row] = stored();
  assert.equal(row.outcome, "miss");
});

test("subida: countPendingUpload no cuenta la fila pendiente, sí la respondida", async () => {
  const { record } = await load();
  seed(answeredWord("cat"));
  seed(pendingWord("zorp"));
  assert.equal(await record.countPendingUpload(), 1);
});
