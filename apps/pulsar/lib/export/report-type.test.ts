import assert from "node:assert/strict";
import { test } from "node:test";

import type { GoalReport } from "./report";

// A report made by hand names its rhythm, even when it is null (RP-110).
test("GoalReport.rhythm is required", () => {
  // @ts-expect-error rhythm is missing
  const withoutRhythm: Pick<GoalReport, "rhythm" | "name"> = { name: "x" };
  assert.equal(withoutRhythm.name, "x");
  const named: Pick<GoalReport, "rhythm"> = { rhythm: null };
  assert.equal(named.rhythm, null);
});
