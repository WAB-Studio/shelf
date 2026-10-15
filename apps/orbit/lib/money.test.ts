import assert from "node:assert/strict";
import { test } from "node:test";

import { convertMinor, pesosToCents } from "./money";

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
