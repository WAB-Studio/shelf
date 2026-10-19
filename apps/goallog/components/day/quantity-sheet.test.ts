import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createTranslator } from "next-intl";

import day from "../../messages/es/day.json";

// The sheet's own imports that reach the server or a CSS module; the message needs neither.
mock.module("@/app/actions/facts", { namedExports: { declareFact: async () => ({ ok: true }), undoFact: async () => ({ ok: true }) } });
mock.module("@/components/ui", { namedExports: {} });
mock.module("@/components/ui/figure", { namedExports: { useTimeWords: () => words } });

// The catalogue's own shape (`messages/es/units.json`), as `figure.test.ts` takes it.
const words = {
  h: (h: string) => `${h} h`,
  min: (min: string) => `${min} min`,
  join: (h: string, min: string) => `${h} ${min}`,
};

const t = createTranslator({ locale: "es", messages: { day } }) as unknown as (
  key: string,
  values?: Record<string, string>,
) => string;

// GoalLog 9: a stale «Anotar» says what another device kept, in the figure the chips draw.
test("a stale «Anotar» names the minutes kept as the chips read them, never {quantity}", async () => {
  const { refusalText } = await import("./quantity-sheet");
  const text = refusalText(t, { error: "day.errors.alreadyNoted", values: { quantity: 90, unit: "minutos" } }, "minutos", words);
  assert.equal(text, "Ya anotaste 1 h 30 min hoy en otro lado. Ábrelo para cambiarlo.");
});

test("a refusal with nothing to fill reads as before", async () => {
  const { refusalText } = await import("./quantity-sheet");
  assert.equal(refusalText(t, { error: "day.errors.quantityInvalid" }, "páginas", words), day.errors.quantityInvalid);
});
