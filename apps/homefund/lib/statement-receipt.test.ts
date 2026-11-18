import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { receiptLikeLine, RECEIPT_LINES } from "./statement-receipt";

const day = (date: string, count: number, from = 1, extra: { reference?: string } = {}) =>
  Array.from({ length: count }, (_, index) => ({ line: from + index, date, amountCents: -1_000 * (index + 1), ...extra }));

describe("receiptLikeLine", () => {
  it("reads a day of many expense lines with no reference as a receipt, naming its first line", () => {
    assert.equal(receiptLikeLine([...day("2026-10-01", 2), ...day("2026-10-02", RECEIPT_LINES, 3)]), 3);
  });

  it("lets a day below the limit through", () => {
    assert.equal(receiptLikeLine(day("2026-10-01", RECEIPT_LINES - 1)), null);
  });

  it("lets lines that carry the bank's reference through, however many", () => {
    assert.equal(receiptLikeLine(day("2026-10-01", 30, 1, { reference: "R1" })), null);
  });

  it("counts neither income nor transfers", () => {
    const income = Array.from({ length: 8 }, (_, index) => ({ line: index + 1, date: "2026-10-01", amountCents: 5_000 }));
    const transfers = Array.from({ length: 8 }, (_, index) => ({ line: index + 1, date: "2026-10-01", amountCents: -5_000, counterAccountId: "a" }));
    assert.equal(receiptLikeLine(income), null);
    assert.equal(receiptLikeLine(transfers), null);
  });
});
