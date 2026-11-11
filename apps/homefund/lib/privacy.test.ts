import assert from "node:assert/strict";
import { test } from "node:test";

import { AMOUNT_MASK, formatMoneyMasked, maskFigure, revealFigures, tagFigure } from "./privacy";

test("a hidden peso figure keeps its mark and loses its digits", () => {
  const shown = formatMoneyMasked(32_229_854_00, "COP", "es", false);
  const hidden = formatMoneyMasked(32_229_854_00, "COP", "es", true);

  assert.match(shown, /32\.229\.854/);
  assert.ok(hidden.includes("$"));
  assert.ok(hidden.includes(AMOUNT_MASK));
  assert.doesNotMatch(hidden, /\d/);
});

test("a hidden dollar figure drops its decimals with the rest of the digits", () => {
  const hidden = formatMoneyMasked(1_234_56, "USD", "en", true);

  assert.doesNotMatch(hidden, /\d/);
  assert.ok(hidden.includes(AMOUNT_MASK));
});

test("a string with no digits is left as it is", () => {
  assert.equal(maskFigure("Sin saldo"), "Sin saldo");
});

test("tagged figures in a sentence mask one by one and lose their tags", () => {
  const sentence = `${tagFigure("$ 10.000")} de ${tagFigure("$ 50.000")}`;

  assert.equal(revealFigures(sentence, false), "$ 10.000 de $ 50.000");
  assert.equal(revealFigures(sentence, true), `$ ${AMOUNT_MASK} de $ ${AMOUNT_MASK}`);
});
