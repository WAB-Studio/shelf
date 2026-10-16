import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCategoryInScope, scopeKeyOf, type ScopeKey } from "./resolve-category";

const U: ScopeKey = "user:u";
const U2: ScopeKey = "user:u2";
const G: ScopeKey = "group:g";

const scopes = new Map<string, ScopeKey>([
  ["P", U],
  ["P2", U2],
  ["G", G],
  ["G1", G],
  ["G2", G],
]);

test("two scopes, one name: the account's scope wins", () => {
  assert.deepEqual(resolveCategoryInScope(["P", "G"], G, scopes), { id: "G" });
  assert.deepEqual(resolveCategoryInScope(["P", "G"], U, scopes), { id: "P" });
});

test("no candidate is unknown whatever the account scope", () => {
  for (const s of [null, U, G]) {
    assert.deepEqual(resolveCategoryInScope([], s, scopes), { error: "unknown" });
  }
});

test("only another scope's candidate is out of scope", () => {
  assert.deepEqual(resolveCategoryInScope(["G"], U, scopes), { error: "outOfScope" });
});

test("two in the same scope stay ambiguous", () => {
  assert.deepEqual(resolveCategoryInScope(["G1", "G2"], G, scopes), { error: "ambiguous" });
});

test("two in the same scope plus one elsewhere stay ambiguous", () => {
  assert.deepEqual(resolveCategoryInScope(["G1", "P", "G2"], G, scopes), { error: "ambiguous" });
});

test("no account scope keeps the old rule", () => {
  assert.deepEqual(resolveCategoryInScope(["P"], null, scopes), { id: "P" });
  assert.deepEqual(resolveCategoryInScope(["P", "G"], null, scopes), { error: "ambiguous" });
});

test("no account scope accepts a lone candidate absent from the map", () => {
  assert.deepEqual(resolveCategoryInScope(["X"], null, new Map()), { id: "X" });
});

test("a candidate with no scope entry is out of scope", () => {
  assert.deepEqual(resolveCategoryInScope(["X"], U, scopes), { error: "outOfScope" });
  assert.deepEqual(resolveCategoryInScope(["X", "P"], U, scopes), { id: "P" });
});

test("another member's personal scope is not mine", () => {
  assert.deepEqual(resolveCategoryInScope(["P2"], U, scopes), { error: "outOfScope" });
  assert.deepEqual(resolveCategoryInScope(["P2", "P"], U, scopes), { id: "P" });
});

test("the scope key reads the XOR", () => {
  assert.equal(scopeKeyOf({ ownerUserId: "u", groupId: null }), "user:u");
  assert.equal(scopeKeyOf({ ownerUserId: null, groupId: "g" }), "group:g");
  assert.equal(scopeKeyOf({ ownerUserId: null, groupId: null }), null);
});

test("the scope key prefers the group when both are given", () => {
  assert.equal(scopeKeyOf({ ownerUserId: "u", groupId: "g" }), "group:g");
});

test("order of candidates does not change the outcome", () => {
  const sets = [["G", "P"], ["G1", "G2", "P"], ["G", "P2"], ["X", "G"], []];
  for (const ids of sets) {
    for (const acct of [null, U, G]) {
      const want = resolveCategoryInScope(ids, acct, scopes);
      const rev = [...ids].reverse();
      assert.deepEqual(resolveCategoryInScope(rev, acct, scopes), want);
      const rot = [...ids.slice(1), ...ids.slice(0, 1)];
      assert.deepEqual(resolveCategoryInScope(rot, acct, scopes), want);
    }
  }
});
