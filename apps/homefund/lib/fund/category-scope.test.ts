import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categoriesInScope, proposedCategoryId, scopeOfAccounts } from "./category-scope";

const accounts = [
  { id: "p1", groupId: null },
  { id: "p2", groupId: null },
  { id: "g1", groupId: "grp" },
];

describe("scopeOfAccounts", () => {
  it("is null when nothing is picked", () => {
    assert.equal(scopeOfAccounts([null, null], accounts), null);
    assert.equal(scopeOfAccounts([], accounts), null);
  });

  it("is group when any picked account belongs to a group", () => {
    assert.equal(scopeOfAccounts(["p1", "g1"], accounts), "group");
  });

  it("is personal when every picked account is personal", () => {
    assert.equal(scopeOfAccounts(["p1", "p2"], accounts), "personal");
    assert.equal(scopeOfAccounts(["p1", null], accounts), "personal");
  });

  it("treats an id outside the list as unset", () => {
    assert.equal(scopeOfAccounts(["missing", null], accounts), null);
    assert.equal(scopeOfAccounts(["missing", "p1"], accounts), "personal");
  });
});

describe("categoriesInScope", () => {
  const list = [
    { id: "a", scope: "personal" as const },
    { id: "b", scope: "group" as const },
    { id: "c", scope: "personal" as const },
  ];

  it("returns every category, in order, for a null scope", () => {
    assert.deepEqual(categoriesInScope(list, null), list);
  });

  it("keeps only the scope's categories, in order", () => {
    assert.deepEqual(
      categoriesInScope(list, "personal").map((c) => c.id),
      ["a", "c"],
    );
    assert.deepEqual(
      categoriesInScope(list, "group").map((c) => c.id),
      ["b"],
    );
  });
});

describe("proposedCategoryId", () => {
  const options = {
    accounts,
    categories: [
      { id: "rent", scope: "personal" as const, kind: "expense", children: [{ id: "rent-sub" }] },
      { id: "salary", scope: "personal" as const, kind: "income", children: [] },
    ],
  };
  const of = (proposedCategoryId_: string | null, proposedDirection: "income" | "expense" | "transfer" | null) => ({
    proposedCategoryId: proposedCategoryId_,
    proposedAccountId: "p1",
    proposedDirection,
  });

  it("keeps a category of the movement's own kind", () => {
    assert.equal(proposedCategoryId(of("rent", "expense"), options), "rent");
    assert.equal(proposedCategoryId(of("rent-sub", "expense"), options), "rent-sub");
    assert.equal(proposedCategoryId(of("salary", "income"), options), "salary");
  });

  it("reads an expense category on an income, and the reverse, as no category", () => {
    assert.equal(proposedCategoryId(of("rent", "income"), options), null);
    assert.equal(proposedCategoryId(of("rent-sub", "income"), options), null);
    assert.equal(proposedCategoryId(of("salary", "expense"), options), null);
  });

  it("proposes no category for a transfer", () => {
    assert.equal(proposedCategoryId(of("rent", "transfer"), options), null);
  });
});
