import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountNamesById, touchesForeignAccount } from "./account-names";

const ownerOf = (name: string) => `De ${name}`;

describe("accountNamesById", () => {
  it("leaves the caller's and the fund's accounts bare", () => {
    const names = accountNamesById(
      [{ id: "a", name: "Nequi", foreignOwner: false, ownerName: null }],
      ownerOf,
      "De otra persona",
    );
    assert.equal(names.get("a"), "Nequi");
  });

  it("writes another member's account with its owner", () => {
    const names = accountNamesById(
      [{ id: "b", name: "Nequi", foreignOwner: true, ownerName: "Andrea" }],
      ownerOf,
      "De otra persona",
    );
    assert.equal(names.get("b"), "Nequi · De Andrea");
  });

  it("falls back to the plain word when the owner has no name", () => {
    const names = accountNamesById(
      [{ id: "c", name: "Nequi", foreignOwner: true, ownerName: null }],
      ownerOf,
      "De otra persona",
    );
    assert.equal(names.get("c"), "Nequi · De otra persona");
  });
});

describe("touchesForeignAccount", () => {
  const accounts = [
    { id: "mine", foreignOwner: false },
    { id: "hers", foreignOwner: true },
  ];

  it("is false for a movement on the caller's own accounts", () => {
    assert.equal(
      touchesForeignAccount({ fromAccountId: "mine", toAccountId: null }, accounts),
      false,
    );
  });

  it("is true when either side is another member's account", () => {
    assert.equal(
      touchesForeignAccount({ fromAccountId: null, toAccountId: "hers" }, accounts),
      true,
    );
    assert.equal(
      touchesForeignAccount({ fromAccountId: "hers", toAccountId: "mine" }, accounts),
      true,
    );
  });

  it("ignores an account the list does not hold", () => {
    assert.equal(
      touchesForeignAccount({ fromAccountId: "gone", toAccountId: null }, accounts),
      false,
    );
  });
});
