import assert from "node:assert/strict";
import { test } from "node:test";

import { creditLines, groupOwed, owedByPerson, type OwedLine, type OwedPerson } from "./owed-to-me";

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

const line = (kind: OwedLine["kind"], cents: number): OwedLine => ({ kind, occurredOn: null, cents, description: null, transactionId: null });

test("what a person already owed leads the sum: the opening plus what was spent, less what they returned", () => {
  assert.equal(owedByPerson([line("opening", 38_576_600)]), 38_576_600);
  assert.equal(owedByPerson([line("opening", 38_576_600), line("spent", 5_000_000), line("returned", -10_000_000)]), 33_576_600);
});

test("a person who returned all of what they already owed is no entry, and paying ahead is none either", () => {
  const owing = (cents: number): OwedPerson => ({ ...person("Yulieth", "COP", cents), breakdown: [line("opening", 100), line("returned", cents - 100)] });
  assert.deepEqual(groupOwed([owing(0), owing(-50)]), []);
});

test("an opening in dollars and spending in pesos are two figures, never one sum", () => {
  const groups = groupOwed([person("Yulieth", "USD", 2_000), person("Yulieth", "COP", 15_000_000)]);
  assert.deepEqual(groups.map((group) => [group.currency, group.totalCents]), [["COP", 15_000_000], ["USD", 2_000]]);
});
