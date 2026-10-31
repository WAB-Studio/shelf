import assert from "node:assert/strict";
import { test } from "node:test";

import {
  convertMinor,
  deriveRate,
  formatAmountTyping,
  amountToInput,
  formatCompactMoney,
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

// RF-128: a figure carrying both marks follows one convention, the last mark
// being the decimal one. Each test names the mutation that must turn it red.

// Mutation: treat mixed marks as groups (strip every mark that has three digits behind it).
test("parseAmount reads the last of two marks as the decimal mark", () => {
  assert.equal(parseAmount("1,234.56"), 123456);
  assert.equal(parseAmount("1.234,56"), 123456);
  assert.equal(parseAmount("1.234.567,89"), 123456789);
  assert.equal(parseAmount("1,234,567.89"), 123456789);
  assert.equal(parseAmount("1.234,00"), 123400);
});

// Mutation: treat mixed marks as groups.
test("parseAmount refuses three decimals after the last of two marks", () => {
  assert.equal(parseAmount("1,234.567"), null);
  assert.equal(parseAmount("1.234,567"), null);
});

// Mutation: take the first mark as the decimal mark.
test("parseAmount does not take the first mark as decimal", () => {
  assert.equal(parseAmount("1,234.5"), 123450);
  assert.equal(parseAmount("1.234,5"), 123450);
  assert.equal(parseAmount("1,234,567.8"), 123456780);
});

test("parseAmount reads a repeated single mark as thousands", () => {
  assert.equal(parseAmount("1.234.567"), 123456700);
  assert.equal(parseAmount("1,234,567"), 123456700);
});

// Mutation: drop the three-digit-group check.
test("parseAmount refuses a group that is not three digits", () => {
  assert.equal(parseAmount("1,23.45"), null);
  assert.equal(parseAmount("1.23,45"), null);
  assert.equal(parseAmount("1.234.56"), null);
  assert.equal(parseAmount("1,2345.67"), null);
  assert.equal(parseAmount("12,34,567"), null);
});

test("parseAmount keeps the lone-mark rule", () => {
  assert.equal(parseAmount("1.500"), 150000);
  assert.equal(parseAmount("1,500"), 150000);
  assert.equal(parseAmount("12345.678"), 1234567800);
  assert.equal(parseAmount("1500.000"), 150000000);
  assert.equal(parseAmount("1.5"), 150);
  assert.equal(parseAmount("1,25"), 125);
  assert.equal(parseAmount("500000"), 50000000);
});

test("formatMoney draws a magnitude, whatever the sign", () => {
  assert.equal(formatMoney(-123456, "COP", "es"), formatMoney(123456, "COP", "es"));
  assert.match(formatMoney(-123456, "COP", "es"), /1\.234$/);
  assert.equal(formatMoney(-1234, "USD", "en"), "$12.34");
});

test("deriveRate divides the counter amount by the amount", () => {
  assert.equal(deriveRate(10_000, "USD", 40_000_000, "COP"), 4000);
});

test("formatAmountTyping groups thousands with the language's mark and keeps the caret among its digits", () => {
  assert.deepEqual(formatAmountTyping("125000", 6, "es"), { text: "125.000", caret: 7 });
  assert.deepEqual(formatAmountTyping("1.2500", 3, "es"), { text: "12.500", caret: 2 });
  assert.deepEqual(formatAmountTyping("1250000", 7, "en"), { text: "1,250,000", caret: 9 });
  assert.deepEqual(formatAmountTyping("1250,5", 6, "es"), { text: "1.250,5", caret: 7 });
  assert.deepEqual(formatAmountTyping(",5", 2, "es"), { text: "0,5", caret: 3 });
  assert.deepEqual(formatAmountTyping("12,345", 6, "es").text, "12.345");
  assert.deepEqual(formatAmountTyping("", 0, "es"), { text: "", caret: 0 });
});

test("what formatAmountTyping writes is what parseAmount reads, in integer cents", () => {
  assert.equal(parseAmount(formatAmountTyping("125000", 6, "es").text), 12_500_000);
  assert.equal(parseAmount(formatAmountTyping("1250000,5", 9, "es").text), 125_000_050);
  assert.equal(parseAmount(formatAmountTyping("1250000.5", 9, "en").text), 125_000_050);
});

test("formatCompactMoney shortens a magnitude and drops the sign", () => {
  const short = formatCompactMoney(-260_000_000, "COP", "es");
  assert.ok(!short.includes("-") && short.length < formatMoney(260_000_000, "COP", "es").length);
  assert.equal(formatCompactMoney(0, "COP", "es").includes("0"), true);
});

// The language's own decimal mark with 1 or 2 digits is the decimal; its own group mark only
// with one digit and no other mark; 3 digits after any mark are a group.
test("formatAmountTyping reads each keystroke as the figure the person means", () => {
  const typed = (raw: string, locale: string) => formatAmountTyping(raw, raw.length, locale).text;
  // Spanish: the keypad's point is a decimal at once.
  assert.equal(typed("12.5", "es"), "12,5");
  assert.equal(parseAmount(typed("12.5", "es")), 1_250);
  assert.equal(typed("12,50", "es"), "12,50");
  assert.equal(parseAmount(typed("12,50", "es")), 1_250);
  assert.equal(typed("1.234,5", "es"), "1.234,5");
  // English mirrors it.
  assert.equal(typed("12,5", "en"), "12.5");
  assert.equal(typed("12.50", "en"), "12.50");
  assert.equal(typed("1,234.5", "en"), "1,234.5");
  // Three digits are a group in either language.
  assert.equal(typed("1,250", "en"), "1,250");
  assert.equal(typed("1.250", "es"), "1.250");
  assert.equal(typed("1,250", "es"), "1.250");
  assert.equal(typed("1.250", "en"), "1,250");
  assert.equal(typed("1.234.567", "es"), "1.234.567");
});

// Backspacing a grouped figure must never turn the group mark into a decimal.
test("backspacing «1.250.000» in Spanish keeps every state a whole figure", () => {
  let text = "1.250.000";
  const seen: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    // The person deletes the last character of what the field shows.
    text = formatAmountTyping(text.slice(0, -1), text.length - 1, "es").text;
    seen.push(text);
  }
  assert.deepEqual(seen, ["12.500", "1.250", "125", "12", "1"]);
  // «125.000» backspaced is «125.00»: the group, not 125 with two decimals.
  assert.equal(formatAmountTyping("125.00", 6, "es").text, "12.500");
  assert.equal(parseAmount(formatAmountTyping("125.00", 6, "es").text), 1_250_000);
  assert.equal(formatAmountTyping("1.250.0", 7, "es").text, "12.500");
  assert.equal(formatAmountTyping("12.50", 5, "es").text, "1.250");
  assert.equal(formatAmountTyping("1.25", 4, "es").text, "125");
  assert.equal(formatAmountTyping("12", 2, "es").text, "12");
  // English: «125,00» is what «125,000» leaves.
  assert.equal(formatAmountTyping("125,00", 6, "en").text, "12,500");
});

test("formatAmountTyping never cuts a third decimal: parseAmount refuses it", () => {
  for (const locale of ["es", "en"]) {
    const mark = locale === "es" ? "," : ".";
    const text = formatAmountTyping(`0${mark}125`, 5, locale).text;
    assert.equal(text, `0${mark}125`);
    assert.equal(parseAmount(text), null);

    const long = formatAmountTyping(`12${mark}3456`, 7, locale).text;
    assert.equal(long, `12${mark}3456`);
    assert.equal(parseAmount(long), null);
  }
});

test("amountToInput writes the locale's decimal mark and parseAmount reads it back", () => {
  assert.equal(amountToInput(1_250, "COP", "es"), "12,50");
  assert.equal(amountToInput(1_250, "COP", "en"), "12.50");
  assert.equal(amountToInput(1_250, "COP"), "12,50");
  for (const locale of ["es", "en"]) {
    assert.equal(parseAmount(amountToInput(1_250, "COP", locale)), 1_250);
  }
});
