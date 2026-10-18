import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAmount } from "@/lib/money";

import { interpretQuickEntry } from "./interpret";

const ctx = { categories: [], accounts: [], defaultAccountId: null };

// The amount the form would store for a message.
function stored(text: string): number | null {
  const { amountPesos } = interpretQuickEntry(text, ctx);
  return amountPesos === null ? null : parseAmount(amountPesos);
}

test("dot thousands read as a group", () => {
  assert.equal(stored("Compraste $12.500 en TIENDA"), 1_250_000);
});

test("comma thousands read as a group", () => {
  assert.equal(stored("Compraste 12,500 en TIENDA"), 1_250_000);
});

test("two decimals after a thousands group keep the centavos", () => {
  assert.equal(stored("Compraste $12.500,07 en TIENDA"), 1_250_007);
});

test("a recibiste message is income", () => {
  assert.equal(
    interpretQuickEntry("Recibiste una transferencia de $50.000", ctx).direction,
    "income",
  );
});

test("a message with no verb has no direction", () => {
  assert.equal(interpretQuickEntry("almuerzo 15000", ctx).direction, null);
});

// The multiplier (RF-22): a number followed by «mil» or «k» is that number times
// a thousand. Expected cents are worked out by hand: 25 mil is 25 000 pesos.

test("«mil» after a space multiplies by a thousand", () => {
  assert.equal(stored("almuerzo 25 mil"), 2_500_000);
});

test("«MIL» glued to the number, in capitals, multiplies as well", () => {
  assert.equal(stored("25MIL taxi"), 2_500_000);
});

test("«k» in either case multiplies by a thousand", () => {
  assert.equal(stored("25k mercado"), 2_500_000);
  assert.equal(stored("25 K"), 2_500_000);
});

test("a decimal mantissa is read before it is multiplied", () => {
  assert.equal(stored("2,5 mil"), 250_000);
  assert.equal(stored("1.25k"), 125_000);
  assert.equal(stored("1,25k"), 125_000);
});

test("larger mantissas keep their digits", () => {
  assert.equal(stored("250 mil"), 25_000_000);
  assert.equal(stored("1500 mil"), 150_000_000);
});

test("the multiplier does no float arithmetic", () => {
  assert.equal(stored("0,07k"), 7_000);
  assert.equal(stored("1,15k"), 115_000);
  // 2.01 * 1000 is 2009.9999999999998 in floating point.
  assert.equal(stored("2,01k"), 201_000);
  assert.equal(stored("8,19k"), 819_000);
});

test("the proposal is an integer peso string", () => {
  const read = (text: string) => interpretQuickEntry(text, ctx).amountPesos;
  assert.equal(read("25 mil"), "25000");
  assert.equal(read("2,5 mil"), "2500");
  assert.equal(read("1,25k"), "1250");
  assert.equal(read("1500 mil"), "1500000");
});

test("a separator and exactly three digits before «mil» proposes no amount", () => {
  assert.equal(interpretQuickEntry("1.500 mil", ctx).amountPesos, null);
  assert.equal(interpretQuickEntry("12.500k", ctx).amountPesos, null);
  assert.equal(interpretQuickEntry("12,500 mil", ctx).amountPesos, null);
});

test("«mil» or «k» inside a word is not a multiplier", () => {
  assert.equal(stored("3 milanesas"), 300);
  assert.equal(stored("4 kg arroz"), 400);
  assert.equal(stored("KFC 15000"), 1_500_000);
});

test("the multiplier token leaves the description with the amount", () => {
  assert.equal(interpretQuickEntry("almuerzo 25 mil", ctx).description, "almuerzo");
  assert.equal(interpretQuickEntry("25k mercado", ctx).description, "mercado");
});

test("a bank message keeps reading its own amount", () => {
  assert.equal(stored("Compraste $25.000 en KFC"), 2_500_000);
});

// The widened multiplier (Q12, 2026-10-18): «m», «millón» and «millones» are a
// million. 2 000 000 pesos is 200 000 000 cents.

test("«m», «millón» and «millones» multiply by a million", () => {
  assert.equal(stored("2m"), 200_000_000);
  assert.equal(stored("3 M"), 300_000_000);
  assert.equal(stored("1 millón"), 100_000_000);
  assert.equal(stored("2 millones"), 200_000_000);
  assert.equal(stored("1 MILLONES"), 100_000_000);
  // Typed on a phone without the accent, the word is the same.
  assert.equal(stored("1 millon"), 100_000_000);
});

test("a decimal mantissa before a million is read without float", () => {
  assert.equal(stored("1,5 millones"), 150_000_000);
  assert.equal(stored("2.5m"), 250_000_000);
  assert.equal(stored("1,15 m"), 115_000_000);
  assert.equal(stored("0,07m"), 7_000_000);
});

test("a million proposal is an integer peso string", () => {
  const read = (text: string) => interpretQuickEntry(text, ctx).amountPesos;
  assert.equal(read("2m"), "2000000");
  assert.equal(read("1,5 millones"), "1500000");
});

test("«mil» stays a thousand, never a million", () => {
  assert.equal(stored("5 mil pesos"), 500_000);
  assert.equal(stored("1 mil"), 100_000);
});

test("a separator and exactly three digits before a million proposes no amount", () => {
  assert.equal(interpretQuickEntry("1.500 m", ctx).amountPesos, null);
  assert.equal(interpretQuickEntry("1,500 millones", ctx).amountPesos, null);
});

test("«m» inside a word is not a multiplier", () => {
  assert.equal(stored("5 metros de cable"), 500);
  assert.equal(stored("2 mangos"), 200);
  assert.equal(stored("4 m2"), 400);
});

test("the million token leaves the description with the amount", () => {
  assert.equal(
    interpretQuickEntry("arriendo 1,5 millones", ctx).description,
    "arriendo",
  );
  assert.equal(interpretQuickEntry("2m carro", ctx).description, "carro");
});

// Where «m» stands (Q12, 2026-10-18): glued to the number, or spaced as the last
// word of the text, it is a million. Spaced with text after it, it is a word of
// its own («5 m de cable» is five metres), so the number reads bare.

test("«m» glued to the number is a million, whatever follows", () => {
  assert.equal(stored("5m"), 500_000_000);
  assert.equal(stored("5m de cable"), 500_000_000);
});

test("«m» spaced as the last word is a million", () => {
  assert.equal(stored("2 m"), 200_000_000);
  assert.equal(stored("gasté 2 m"), 200_000_000);
  assert.equal(stored("gasté 2 M  "), 200_000_000);
});

test("«m» spaced with text after it is no multiplier: the number reads bare", () => {
  assert.equal(stored("5 m de cable"), 500);
  assert.equal(stored("3 M arriendo"), 300);
  assert.equal(interpretQuickEntry("5 m de cable", ctx).description, "m de cable");
});

test("«millón» and «millones» stay a million with text after them", () => {
  assert.equal(stored("2 millones arriendo"), 200_000_000);
  assert.equal(stored("1 millón de pesos"), 100_000_000);
  assert.equal(stored("3 millon carro"), 300_000_000);
});

test("«mil» with no number before it is a thousand pesos", () => {
  const read = (text: string) => interpretQuickEntry(text, ctx).amountPesos;
  assert.equal(read("mil pesos"), "1000");
  assert.equal(stored("pagué mil"), 100_000);
  assert.equal(stored("Mil"), 100_000);
  assert.equal(stored("pagué mil por 3 empanadas"), 100_000);
});

test("«mil» alone leaves the description", () => {
  assert.equal(interpretQuickEntry("pagué mil", ctx).description, "pagué");
  assert.equal(interpretQuickEntry("mil pesos", ctx).description, "pesos");
});

test("«mil» alone never reads as a million, nor inside a word", () => {
  assert.notEqual(stored("mil"), 100_000_000);
  assert.equal(interpretQuickEntry("milanesa", ctx).amountPesos, null);
  assert.equal(interpretQuickEntry("almuerzo", ctx).amountPesos, null);
});

// Two accounts that end in the same four digits cannot be told apart by the
// message, so none is picked: the proposal falls back to the default account.
test("two accounts sharing the mentioned last four fall back to the default", () => {
  const accounts = [
    { id: "a1", name: "Visa", lastFour: "1234" },
    { id: "a2", name: "Mastercard", lastFour: "1234" },
    { id: "a3", name: "Ahorros", lastFour: "9999" },
  ];
  const proposal = interpretQuickEntry("Compraste $12.500 con tarjeta *1234 en TIENDA", {
    categories: [],
    accounts,
    defaultAccountId: "a3",
  });
  assert.equal(proposal.accountId, "a3");
  assert.equal(
    interpretQuickEntry("Compraste $12.500 con tarjeta *1234", { categories: [], accounts, defaultAccountId: null }).accountId,
    null,
  );
});

test("one account matching the mentioned last four is picked over the default", () => {
  const proposal = interpretQuickEntry("Compraste $12.500 con tarjeta *1234", {
    categories: [],
    accounts: [
      { id: "a1", name: "Visa", lastFour: "1234" },
      { id: "a3", name: "Ahorros", lastFour: "9999" },
    ],
    defaultAccountId: "a3",
  });
  assert.equal(proposal.accountId, "a1");
});
