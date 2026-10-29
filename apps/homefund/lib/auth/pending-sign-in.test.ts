import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { clearPending, readPending, writePending } from "./pending-sign-in";

// RF-146 (D5): the address a code was sent to survives a relaunch for 60 minutes,
// kept as `{ email, sentAt }` under one key of `localStorage`. The storage and the
// clock are stubs, so no test reads the module's text: each assertion is a real call.

const MINUTE = 60_000;
const EMAIL = "persona@example.com";

let store: Map<string, string>;
let now: number;
let broken: boolean;
let cookie: string;
const realNow = Date.now;
const SENT = Date.UTC(2026, 9, 17, 12, 0, 0);

beforeEach(() => {
  store = new Map();
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  broken = false;
  cookie = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return cookie;
      },
    },
  });
  Date.now = () => now;
  const guard = <T>(fn: () => T): T => {
    if (broken) throw new Error("storage unavailable");
    return fn();
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => guard(() => store.get(key) ?? null),
      setItem: (key: string, value: string) => guard(() => void store.set(key, value)),
      removeItem: (key: string) => guard(() => void store.delete(key)),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      clear: () => store.clear(),
    },
  });
});

afterEach(() => {
  Date.now = realNow;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "document");
});

test("nothing was sent: there is nothing pending", () => {
  assert.equal(readPending(), null);
});

test("a written address is read back as it was written", () => {
  writePending(EMAIL);
  assert.deepEqual(readPending(), { email: EMAIL, sentAt: SENT });
});

test("it keeps { email, sentAt } under a single key, sentAt being the moment of the send", () => {
  writePending(EMAIL);
  assert.equal(store.size, 1);
  const [raw] = [...store.values()];
  assert.deepEqual(JSON.parse(raw!), { email: EMAIL, sentAt: now });
});

test("it holds at minute 5 and at the last moment of the hour", () => {
  writePending(EMAIL);
  now += 5 * MINUTE;
  assert.deepEqual(readPending(), { email: EMAIL, sentAt: SENT });
  now += 54 * MINUTE + 59_000;
  assert.deepEqual(readPending(), { email: EMAIL, sentAt: SENT });
});

test("at 60 minutes and after, nothing is pending and the stale copy is gone", () => {
  writePending(EMAIL);
  now += 60 * MINUTE;
  assert.equal(readPending(), null);
  assert.equal(store.size, 0, "an expired copy is not left behind");

  writePending(EMAIL);
  now += 61 * MINUTE;
  assert.equal(readPending(), null);
});

test("a second send replaces the address and restarts the hour", () => {
  writePending(EMAIL);
  now += 50 * MINUTE;
  writePending("otra@example.com");
  assert.equal(store.size, 1);
  now += 50 * MINUTE;
  assert.deepEqual(readPending(), { email: "otra@example.com", sentAt: SENT + 50 * MINUTE });
});

test("clearing leaves nothing pending, and clearing twice is harmless", () => {
  writePending(EMAIL);
  clearPending();
  assert.equal(readPending(), null);
  assert.equal(store.size, 0);
  assert.doesNotThrow(() => clearPending());
});

test("clearing touches no other key of the storage", () => {
  store.set("theme", "dark");
  writePending(EMAIL);
  clearPending();
  assert.deepEqual([...store.entries()], [["theme", "dark"]]);
});

// `sentAt` is the current moment wherever the shape allows it, so only the shape can refuse.
for (const [why, raw] of [
  ["not JSON", () => "{no"],
  ["a bare string", () => JSON.stringify(EMAIL)],
  ["without an address", () => JSON.stringify({ sentAt: now })],
  ["with an empty address", () => JSON.stringify({ email: "", sentAt: now })],
  ["without a moment", () => JSON.stringify({ email: EMAIL })],
  ["with a moment that is not a number", () => JSON.stringify({ email: EMAIL, sentAt: "ayer" })],
  ["null", () => "null"],
] as const) {
  test(`a stored value ${why} is nothing pending, never a throw`, () => {
    writePending(EMAIL);
    store.set([...store.keys()][0]!, raw());
    assert.doesNotThrow(() => readPending());
    assert.equal(readPending(), null);
  });
}

test("a storage that refuses (private mode, quota) never throws and reads as nothing pending", () => {
  broken = true;
  assert.doesNotThrow(() => writePending(EMAIL));
  assert.equal(readPending(), null);
  assert.doesNotThrow(() => clearPending());
});

test("with no storage at all (server render) every call is quiet", () => {
  Reflect.deleteProperty(globalThis, "localStorage");
  assert.equal(readPending(), null);
  assert.doesNotThrow(() => writePending(EMAIL));
  assert.doesNotThrow(() => clearPending());
});

// The seed sent: pending at SENT, read later with the clock `now` passed in.

test("readPending(now) judges the hour by the moment it is given, not by the clock", () => {
  writePending(EMAIL);
  assert.deepEqual((readPending as (now?: number) => ReturnType<typeof readPending>)(SENT + 59 * MINUTE), { email: EMAIL, sentAt: SENT });
  assert.equal((readPending as (now?: number) => ReturnType<typeof readPending>)(SENT + 60 * MINUTE), null);
});

test("a landed link (marker at or after sentAt) leaves nothing pending", () => {
  writePending(EMAIL);
  cookie = `homefund-signed-in-at=${SENT + 5_000}`;
  assert.equal(readPending(), null);
});

test("a marker at the very moment of the send also clears it", () => {
  writePending(EMAIL);
  cookie = `homefund-signed-in-at=${SENT}`;
  assert.equal(readPending(), null);
});

test("an older marker (a previous sign-in) does not clear a newer send", () => {
  writePending(EMAIL);
  cookie = `homefund-signed-in-at=${SENT - 1}`;
  assert.deepEqual(readPending(), { email: EMAIL, sentAt: SENT });
});

test("the marker is found among other cookies; a lookalike name or a non-number does not clear", () => {
  writePending(EMAIL);
  cookie = `theme=dark; homefund-signed-in-at=${SENT + 1}; other=1`;
  assert.equal(readPending(), null);

  writePending(EMAIL);
  cookie = `x-homefund-signed-in-at=${SENT + 1}; homefund-signed-in-at=ayer`;
  assert.deepEqual(readPending(), { email: EMAIL, sentAt: SENT });
});

test("a new send after the landing is pending again: the marker is older than its sentAt", () => {
  writePending(EMAIL);
  cookie = `homefund-signed-in-at=${SENT + 1_000}`;
  now += 10 * MINUTE;
  writePending(EMAIL);
  assert.deepEqual(readPending(), { email: EMAIL, sentAt: SENT + 10 * MINUTE });
});
