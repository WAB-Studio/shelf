import assert from "node:assert/strict";
import { test } from "node:test";

import {
  convertMinor,
  deriveRate,
  formatMoney,
  maxAmountMinor,
  parseAmount,
  pesosToCents,
} from "./money";

test("pesosToCents is exact where pesos * 100 drifts", () => {
  assert.equal(pesosToCents(1.15), 115);
  assert.equal(pesosToCents(4.35), 435);
  assert.equal(pesosToCents(0.07), 7);
  assert.equal(pesosToCents(1234567.89), 123456789);
  assert.equal(pesosToCents(0), 0);
});

test("pesosToCents keeps the sign and rounds half away from zero", () => {
  assert.equal(pesosToCents(-1.15), -115);
  assert.equal(pesosToCents(-0.07), -7);
  assert.equal(pesosToCents(1.005), 101);
  assert.equal(pesosToCents(-1.005), -101);
  assert.equal(pesosToCents(1000000), 100000000);
});

test("convertMinor rounds the decimal product once, not the float one", () => {
  // 100 * 1.005 is 100.49999999999999 as a float; the decimal product is 100.5.
  assert.equal(convertMinor(100, 1.005), 101);
  assert.equal(convertMinor(100, 0.145), 15);
  assert.equal(convertMinor(100, 1.255), 126);
  assert.equal(convertMinor(1000, 1), 1000);
  assert.equal(convertMinor(-100, 1.005), -101);
});

test("convertMinor reads a small rate written with an exponent", () => {
  assert.equal(convertMinor(10_000_000, 2.4e-7), 2);
  assert.equal(convertMinor(100, 0.000241), 0);
});

test("parseAmount refuses a third decimal instead of rounding it", () => {
  assert.equal(parseAmount("1,2345"), null);
});

test("parseAmount refuses one above the cap and takes the cap", () => {
  const cap = maxAmountMinor("COP");

  assert.equal(parseAmount("100000000000"), cap + 100);
  assert.ok(parseAmount("100000000000")! > cap);
  assert.equal(parseAmount("99999999999"), cap);
});

test("formatMoney draws a magnitude, whatever the sign", () => {
  assert.equal(formatMoney(-123456, "COP", "es"), formatMoney(123456, "COP", "es"));
  assert.match(formatMoney(-123456, "COP", "es"), /1\.234$/);
  assert.equal(formatMoney(-1234, "USD", "en"), "$12.34");
});

test("deriveRate divides the counter amount by the amount", () => {
  assert.equal(deriveRate(10_000, "USD", 40_000_000, "COP"), 4000);
});
