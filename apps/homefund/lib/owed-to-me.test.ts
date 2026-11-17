import assert from "node:assert/strict";
import { test } from "node:test";

import { creditLines, groupOwed, owedByPerson, type OwedPerson } from "./owed-to-me";

const person = (name: string, currency: string, cents: number): OwedPerson => ({
  key: `${name}|${currency}`,
  name,
  currency,
  cents,
  source: "person",
  labelId: name,
  breakdown: [],
});

test("a credit's lines add up to the receivable's balance, with «other» only when they do not", () => {
  const plain = creditLines({ cents: 900_00, on: "2026-01-02" }, [{ on: "2026-02-01", cents: 150_00 }], 750_00);
  assert.deepEqual(plain.map((line) => line.kind), ["opening", "payment"]);
  assert.equal(owedByPerson(plain), 750_00);

  const adjusted = creditLines({ cents: 900_00, on: "2026-01-02" }, [{ on: "2026-02-01", cents: 150_00 }], 700_00);
  assert.deepEqual(adjusted.map((line) => line.kind), ["opening", "payment", "other"]);
  assert.equal(owedByPerson(adjusted), 700_00);
});

test("people are grouped by currency, the largest first, and who owes nothing is left out", () => {
  const groups = groupOwed([person("Ana", "COP", 0), person("Carlos", "COP", 40), person("Beto", "COP", 90), person("Lola", "USD", 5), person("Paz", "USD", -3)]);
  assert.deepEqual(groups.map((group) => [group.currency, group.totalCents, group.people.map((one) => one.name)]), [
    ["COP", 130, ["Beto", "Carlos"]],
    ["USD", 5, ["Lola"]],
  ]);
});
