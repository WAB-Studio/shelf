import assert from "node:assert/strict";
import { test } from "node:test";

import { memberDebtBalances, pendingBetween, type MemberDebtEntry } from "./member-debts";
import { recordMemberDebtSchema } from "./validation/member-debt";

const papa = "22222222-2222-4222-8222-222222222222";
const adrian = "11111111-1111-4111-8111-111111111111";
const sofia = "33333333-3333-4333-8333-333333333333";
const names: Record<string, string> = { [papa]: "Papá", [adrian]: "Adrian", [sofia]: "Sofía" };

function entry(kind: "debt" | "payment", debtor: string, creditor: string, amountCents: number, currency = "COP"): MemberDebtEntry {
  return {
    id: `${kind}-${debtor}-${creditor}-${amountCents}`,
    kind,
    debtorMemberId: debtor,
    debtorName: names[debtor],
    creditorMemberId: creditor,
    creditorName: names[creditor],
    amountCents,
    currency,
    occurredOn: "2026-11-01",
    description: null,
  };
}

test("a payment takes from the debt it pays", () => {
  const balances = memberDebtBalances([entry("debt", papa, adrian, 200_000_00), entry("payment", papa, adrian, 50_000_00)]);
  assert.deepEqual(balances, [
    { debtorMemberId: papa, debtorName: "Papá", creditorMemberId: adrian, creditorName: "Adrian", currency: "COP", pendingCents: 150_000_00 },
  ]);
  assert.equal(pendingBetween(balances, papa, adrian, "COP"), 150_000_00);
  assert.equal(pendingBetween(balances, adrian, papa, "COP"), 0);
});

test("debts both ways net into one figure, whichever id sorts first", () => {
  const balances = memberDebtBalances([entry("debt", adrian, papa, 50_00), entry("debt", papa, adrian, 200_00)]);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].debtorMemberId, papa);
  assert.equal(balances[0].pendingCents, 150_00);
});

test("a settled pair is left out and each currency stands alone", () => {
  const balances = memberDebtBalances([
    entry("debt", papa, adrian, 100_00),
    entry("payment", papa, adrian, 100_00),
    entry("debt", papa, adrian, 30_00, "USD"),
    entry("debt", sofia, papa, 10_00),
  ]);
  assert.deepEqual(
    balances.map((b) => [b.debtorName, b.creditorName, b.currency, b.pendingCents]),
    [
      ["Papá", "Adrian", "USD", 30_00],
      ["Sofía", "Papá", "COP", 10_00],
    ],
  );
});

test("an entry names two different members and a positive amount, read in cents", () => {
  const base = { kind: "debt", debtorMemberId: papa, creditorMemberId: adrian, amount: "200.000", currency: "COP", occurredOn: "2026-11-01", description: " moto " };
  const ok = recordMemberDebtSchema.safeParse(base);
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.equal(ok.data.amountCents, 200_000_00);
    assert.equal(ok.data.description, "moto");
  }
  const cases: [Record<string, unknown>, string][] = [
    [{ creditorMemberId: papa }, "memberDebts.errors.sameMember"],
    [{ amount: "0" }, "memberDebts.errors.amountInvalid"],
    [{ amount: "" }, "memberDebts.errors.amountRequired"],
    [{ debtorMemberId: "papa" }, "memberDebts.errors.debtorRequired"],
    [{ currency: "EUR" }, "memberDebts.errors.currencyInvalid"],
  ];
  for (const [patch, message] of cases) {
    const verdict = recordMemberDebtSchema.safeParse({ ...base, ...patch });
    assert.equal(verdict.success, false, message);
    if (!verdict.success) assert.equal(verdict.error.issues[0].message, message);
  }
});
