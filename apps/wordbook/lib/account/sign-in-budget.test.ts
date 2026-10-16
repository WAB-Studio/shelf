// RL-22 and W1: the sign-in budget's own `noKey`, read for real (the action's
// test stubs `claimSignInLink` whole). The salt, the caller key and the
// claims are stand-ins; nothing is read, written or sent.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

const env = {
  CLIENT_KEY_SALT: "salt-salt-salt-salt-1234" as string | undefined,
  SIGN_IN_LINK_DAILY_CLIENT_CAP: 5,
  SIGN_IN_LINK_DAILY_ADDRESS_CAP: 3,
};
const state = { caller: "ck-7e1d" as string | null, allows: [true, true], claims: [] as unknown[][] };

mock.module(here("../env.ts"), { namedExports: { env } });
mock.module(here("../word/client-budget.ts"), {
  namedExports: {
    scopedClientKey: () => state.caller,
    claimClientCall: async (...args: unknown[]) => {
      state.claims.push(args);
      return state.allows[state.claims.length - 1] ?? true;
    },
  },
});

const real = { warn: console.warn };
let warns: unknown[][] = [];
beforeEach(() => {
  warns = [];
  console.warn = (...a: unknown[]) => void warns.push(a);
  env.CLIENT_KEY_SALT = "salt-salt-salt-salt-1234";
  state.caller = "ck-7e1d";
  state.allows = [true, true];
  state.claims = [];
});
afterEach(() => Object.assign(console, real));

const ADDRESS = "Reader.Person@example.invalid";

test("no salt: noKey, one signin no-caller line, no claim spent", async () => {
  env.CLIENT_KEY_SALT = undefined;
  const { claimSignInLink } = await import("./sign-in-budget");
  assert.equal(await claimSignInLink(new Headers({ "x-forwarded-for": "9.9.9.9" }), ADDRESS), "noKey");
  assert.deepEqual(warns, [["[paid-dark]", "signin", "no-caller"]]);
  assert.equal(state.claims.length, 0);
});

test("a salt but no caller address: noKey, the same one line, no claim spent", async () => {
  state.caller = null;
  const { claimSignInLink } = await import("./sign-in-budget");
  assert.equal(await claimSignInLink(new Headers(), ADDRESS), "noKey");
  assert.deepEqual(warns, [["[paid-dark]", "signin", "no-caller"]]);
  assert.equal(state.claims.length, 0);
});

test("a salt and a caller: ok, both claims, and the log stays silent", async () => {
  const { claimSignInLink } = await import("./sign-in-budget");
  assert.equal(await claimSignInLink(new Headers(), ADDRESS), "ok");
  assert.equal(state.claims.length, 2);
  assert.deepEqual(state.claims[0], ["ck-7e1d", 5]);
  assert.equal(state.claims[1][1], 3);
  assert.deepEqual(warns, []);
});

test("refused at the caller's cap: rateLimited, one claim, no dark line", async () => {
  state.allows = [false, true];
  const { claimSignInLink } = await import("./sign-in-budget");
  assert.equal(await claimSignInLink(new Headers(), ADDRESS), "rateLimited");
  assert.equal(state.claims.length, 1);
  assert.deepEqual(warns, []);
});

test("refused at the address's cap: rateLimited, no dark line, and the address never reaches the log", async () => {
  state.allows = [true, false];
  const { claimSignInLink } = await import("./sign-in-budget");
  assert.equal(await claimSignInLink(new Headers(), ADDRESS), "rateLimited");
  assert.deepEqual(warns, []);
});

test("the noKey line carries neither the address nor the salt", async () => {
  state.caller = null;
  const { claimSignInLink } = await import("./sign-in-budget");
  await claimSignInLink(new Headers(), ADDRESS);
  const text = JSON.stringify(warns).toLowerCase();
  assert.equal(warns.length, 1);
  for (const secret of ["reader.person", "example.invalid", "salt-salt", "ck-7e1d"]) {
    assert.ok(!text.includes(secret), `the log line carries ${secret}`);
  }
});
