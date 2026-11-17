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
  withInterest: null,
});

test("a credit is one line, the capital its loan still owes, which is the whole figure", () => {
  const lines = creditLines(453_269_600);
  assert.deepEqual(lines.map((line) => line.kind), ["capital"]);
  assert.equal(owedByPerson(lines), 453_269_600);
});

test("people are grouped by currency, the largest first, and who owes nothing is left out", () => {
  const groups = groupOwed([person("Ana", "COP", 0), person("Carlos", "COP", 40), person("Beto", "COP", 90), person("Lola", "USD", 5), person("Paz", "USD", -3)]);
  assert.deepEqual(groups.map((group) => [group.currency, group.totalCents, group.people.map((one) => one.name)]), [
    ["COP", 130, ["Beto", "Carlos"]],
    ["USD", 5, ["Lola"]],
  ]);
});
