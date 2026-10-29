import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Chips and paired fields are spaced by `ChipRow` and `FieldPair`, never by
// `Flex` or an inline `style`.
for (const file of ["commitment-form.tsx", "phase-form.tsx"]) {
  test(`${file} holds no Flex and no inline style`, () => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /<Flex\b/);
    assert.doesNotMatch(source, /style=/);
  });
}
