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

// The widened multiplier (Q12, 2026-10-18; critic C2, same day): an uppercase
// «M», «millón» and «millones» are a million; a lowercase «m» never is. 2 000 000 pesos is 200 000 000 cents.

test("«M», «millón» and «millones» multiply by a million", () => {
  assert.equal(stored("2M"), 200_000_000);
  assert.equal(stored("3 M"), 300_000_000);
  assert.equal(stored("1 millón"), 100_000_000);
  assert.equal(stored("2 millones"), 200_000_000);
  assert.equal(stored("1 MILLONES"), 100_000_000);
  // Typed on a phone without the accent, the word is the same.
  assert.equal(stored("1 millon"), 100_000_000);
});

test("a decimal mantissa before a million is read without float", () => {
  assert.equal(stored("1,5 millones"), 150_000_000);
  assert.equal(stored("2.5M"), 250_000_000);
  assert.equal(stored("1,15 M"), 115_000_000);
  assert.equal(stored("0,07M"), 7_000_000);
});

test("a million proposal is an integer peso string", () => {
  const read = (text: string) => interpretQuickEntry(text, ctx).amountPesos;
  assert.equal(read("2M"), "2000000");
  assert.equal(read("1,5 millones"), "1500000");
});

test("«mil» stays a thousand, never a million", () => {
  assert.equal(stored("5 mil pesos"), 500_000);
  assert.equal(stored("1 mil"), 100_000);
});

test("a separator and exactly three digits before a million proposes no amount", () => {
  assert.equal(interpretQuickEntry("1.500 M", ctx).amountPesos, null);
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
  assert.equal(interpretQuickEntry("2M carro", ctx).description, "carro");
});

// Where «M» stands: glued to the number, or spaced as the last word of the text,
// it is a million. Spaced with text after it, it asks (below).

test("«M» glued to the number is a million, whatever follows", () => {
  assert.equal(stored("5M"), 500_000_000);
  assert.equal(stored("5M de cable"), 500_000_000);
  assert.equal(askOf("5M de cable"), null);
});

test("«M» spaced as the last word is a million", () => {
  assert.equal(stored("2 M"), 200_000_000);
  assert.equal(stored("gasté 2 M"), 200_000_000);
  assert.equal(stored("gasté 2 M  "), 200_000_000);
});

// M75 (Q27 b, RF-22): a lowercase «m» right after a number is not read as a
// figure. The parser proposes no amount and asks with three choices in cents.

test("a lowercase «m» after a number asks with three choices and proposes no amount", () => {
  for (const [text, token, pesos] of [
    ["25 m", "25 m", 25],
    ["5m arriendo", "5m", 5],
    ["2 m", "2 m", 2],
    ["5 m de cable", "5 m", 5],
    ["gasté 2 m", "2 m", 2],
    ["5m", "5m", 5],
  ] as const) {
    assert.equal(interpretQuickEntry(text, ctx).amountPesos, null, `${text} proposes no amount`);
    assert.deepEqual(
      askOf(text),
      { token, choices: [pesos * 100, pesos * 100_000, pesos * 100_000_000] },
      text,
    );
  }
});

test("«5m arriendo» asks and keeps «arriendo» as the description", () => {
  assert.equal(interpretQuickEntry("5m arriendo", ctx).description, "arriendo");
});

test("«25 mil», «25k» and «3 M» keep their rules next to the new ask", () => {
  assert.equal(stored("25 mil"), 2_500_000);
  assert.equal(askOf("25 mil"), null);
  assert.equal(stored("25k"), 2_500_000);
  assert.equal(askOf("25k"), null);
  assert.equal(askOf("3 M arriendo")?.choices.length, 2);
});

test("a multiplier word that does not touch the amount multiplies nothing", () => {
  assert.equal(interpretQuickEntry("pan 25 bien mil", ctx).amountPesos, "25");
  assert.equal(stored("pan 25 bien mil"), 2_500);
  assert.equal(interpretQuickEntry("pan 25 bien k", ctx).amountPesos, "25");
  assert.equal(interpretQuickEntry("pan 25 bien millones", ctx).amountPesos, "25");
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

// M71 (Q12-e, Q12-f): a spaced «m» with words after it is not guessed. The
// parser proposes no amount and asks, offering the bare number and the number
// times a million, both in integer cents.

type Ask = { token: string; choices: number[] };
function askOf(text: string): Ask | null {
  const result = interpretQuickEntry(text, ctx) as { ask?: Ask | null };
  return result.ask ?? null;
}

test("«3 M arriendo» asks: no amount, the token as typed, two choices in cents", () => {
  assert.equal(interpretQuickEntry("3 M arriendo", ctx).amountPesos, null);
  assert.deepEqual(askOf("3 M arriendo"), {
    token: "3 M",
    choices: [300, 300_000_000],
  });
});

test("«5 M de cable» asks too, with its own token and choices", () => {
  assert.equal(interpretQuickEntry("5 M de cable", ctx).amountPesos, null);
  assert.deepEqual(askOf("5 M de cable"), {
    token: "5 M",
    choices: [500, 500_000_000],
  });
});

test("the ask sits in the middle of a message and after other words", () => {
  assert.equal(interpretQuickEntry("pagué 12 M de tubo hoy", ctx).amountPesos, null);
  assert.deepEqual(askOf("pagué 12 M de tubo hoy"), {
    token: "12 M",
    choices: [1_200, 1_200_000_000],
  });
});

test("a decimal mantissa asks in cents without float drift", () => {
  assert.deepEqual(askOf("2,5 M cable"), {
    token: "2,5 M",
    choices: [250, 250_000_000],
  });
  assert.deepEqual(askOf("0,07 M cable"), {
    token: "0,07 M",
    choices: [7, 7_000_000],
  });
});

test("the second choice is always the first times a million", () => {
  for (const n of [1, 2, 7, 15, 99, 250, 1500]) {
    const ask = askOf(`${n} M arriendo`);
    assert.ok(ask, `${n} M arriendo should ask`);
    assert.equal(ask.choices[0], n * 100);
    assert.equal(ask.choices[1], ask.choices[0] * 1_000_000);
  }
});

test("a lowercase «m» with words after it asks too", () => {
  assert.equal(stored("4 m taxi"), null);
  assert.deepEqual(askOf("4 m taxi")?.choices, [400, 400_000, 400_000_000]);
});

test("the cases that read cleanly never ask", () => {
  for (const text of [
    "5M",
    "5M de cable",
    "2 M",
    "gasté 2 M",
    "gasté 2 M  ",
    "2 millones arriendo",
    "1 millón de pesos",
    "3 millon carro",
    "25 mil taxi",
    "25k mercado",
    "25 K",
    "5 metros de cable",
    "2 mangos",
    "4 m2",
    "mil pesos",
    "pagué mil",
    "almuerzo 15000",
    "un millón",
    "",
  ]) {
    assert.equal(askOf(text), null, `${text} must not ask`);
  }
});

test("a message that asks never also proposes an amount", () => {
  for (const text of ["3 M arriendo", "5 M de cable", "pagué 12 M de tubo hoy"]) {
    assert.equal(interpretQuickEntry(text, ctx).amountPesos, null, text);
  }
});

test("«un millón» and «millón» with no number before it propose 1.000.000", () => {
  const read = (text: string) => interpretQuickEntry(text, ctx).amountPesos;
  assert.equal(read("un millón"), "1000000");
  assert.equal(read("millón"), "1000000");
  assert.equal(read("arriendo un millón"), "1000000");
  assert.equal(read("un millon de arriendo"), "1000000");
  assert.equal(stored("pagué un millón"), 100_000_000);
});

test("«un millón» is exactly a million, not a thousand and not ten million", () => {
  assert.equal(stored("un millón"), 100_000_000);
  assert.equal(stored("un millón arriendo"), 100_000_000);
});

test("«millón» inside a word proposes nothing", () => {
  assert.equal(interpretQuickEntry("millonario", ctx).amountPesos, null);
});

test("a digit before «millón» keeps the multiplier, not the proposal", () => {
  assert.equal(stored("2 millón"), 200_000_000);
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
