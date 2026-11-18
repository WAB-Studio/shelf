import assert from "node:assert/strict";
import { test } from "node:test";

import { dateAfterSkip, pickableCategories, plainName, upcomingItems } from "./upcoming";

const payment = (id: string, dueDate: string, fromAccountId: string | null, toAccountId: string | null) =>
  ({ id, dueDate, fromAccountId, toAccountId }) as never;
const rule = (id: string, nextRunOn: string, description: string, fromAccountId: string | null) =>
  ({ id, nextRunOn, description, fromAccountId, toAccountId: null }) as never;
const charge = (name: string, nextExpected: string, accountId: string, active = true) =>
  ({ name, nextExpected, accountId, active }) as never;

test("one list, soonest first, each row named by what it is", () => {
  const items = upcomingItems({
    payments: [payment("p", "2026-12-15", "a", null), payment("i", "2026-12-01", null, "a")],
    rules: [rule("r", "2026-12-01", "Arriendo", "a")],
    charges: [charge("Spotify", "2026-11-30", "a")],
  });
  assert.deepEqual(
    items.map((item) => [item.kind, item.date]),
    [
      ["subscription", "2026-11-30"],
      ["income", "2026-12-01"],
      ["rule", "2026-12-01"],
      ["payment", "2026-12-15"],
    ],
  );
});

test("a subscription a rule already generates is listed once, and a stopped one not at all", () => {
  const items = upcomingItems({
    payments: [],
    rules: [rule("r", "2026-12-01", "Netflix 2", "a")],
    charges: [charge("NETFLIX", "2026-12-01", "a"), charge("Gym", "2026-12-02", "a", false)],
  });
  assert.deepEqual(items.map((item) => item.kind), ["rule"]);
});

test("plainName drops case, accents, digits and punctuation", () => {
  assert.equal(plainName("  Café-Ñandú 12! "), "cafe nandu");
});

test("skipping moves a rule one period on and keeps its day anchor", () => {
  const base = { intervalN: 1, dayOfMonth: 31 };
  assert.equal(dateAfterSkip({ ...base, frequency: "monthly", nextRunOn: "2026-01-31" }), "2026-02-28");
  assert.equal(dateAfterSkip({ ...base, frequency: "monthly", nextRunOn: "2026-02-28" }), "2026-03-31");
  assert.equal(dateAfterSkip({ ...base, frequency: "monthly", intervalN: 2, nextRunOn: "2026-11-30" }), "2027-01-31");
  assert.equal(dateAfterSkip({ ...base, frequency: "yearly", dayOfMonth: 15, nextRunOn: "2026-03-15" }), "2027-03-15");
  assert.equal(dateAfterSkip({ ...base, frequency: "weekly", dayOfMonth: null, nextRunOn: "2026-11-17" }), "2026-11-24");
});

test("pickableCategories offers each subcategory under its parent, cut to the scope and the kind", () => {
  const categories = [
    { id: "m", name: "Mercado", scope: "personal", kind: "expense", children: [{ id: "l", name: "Lácteos" }] },
    { id: "s", name: "Salario", scope: "personal", kind: "income", children: [] },
    { id: "g", name: "Casa", scope: "group", kind: "expense", children: [{ id: "a", name: "Aseo" }] },
  ] as const;
  const mark = (name: string) => `${name} (fondo)`;
  assert.deepEqual(pickableCategories(categories, "personal", "expense", mark), [
    { id: "m", name: "Mercado", scope: "personal" },
    { id: "l", name: "Mercado › Lácteos", scope: "personal" },
  ]);
  assert.deepEqual(pickableCategories(categories, "group", "expense", mark).map((c) => c.name), [
    "Casa (fondo)",
    "Casa › Aseo (fondo)",
  ]);
  assert.deepEqual(pickableCategories(categories, null, "income", mark).map((c) => c.id), ["s"]);
});
