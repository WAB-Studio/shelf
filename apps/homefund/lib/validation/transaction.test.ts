import assert from "node:assert/strict";
import { test } from "node:test";

import { maxAmountMinor } from "@/lib/money";
import { pesoAmountSchema } from "./transaction";

const schema = pesoAmountSchema({
  required: "required",
  invalid: "invalid",
  tooLarge: "tooLarge",
});

// Mutation: off by one in the cap comparison (`>` becomes `>=`, or the bound `+ 1`).
test("the amount schema takes the cap and refuses one cent above it", () => {
  const cap = maxAmountMinor("COP");
  const written = (minor: number) =>
    `${Math.trunc(minor / 100)},${String(minor % 100).padStart(2, "0")}`;

  assert.equal(schema.safeParse(written(cap)).success, true);

  const over = schema.safeParse(written(cap + 1));
  assert.equal(over.success, false);
  assert.deepEqual(over.error?.issues.map((issue) => issue.message), ["tooLarge"]);
});
