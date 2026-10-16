import assert from "node:assert/strict";
import { test } from "node:test";

import * as debtTerms from "./debt-terms";
import * as recurringRule from "./recurring-rule";

test("the schemas of the two uncalled write endpoints are no longer exported", () => {
  assert.equal("deleteDebtTermsSchema" in debtTerms, false);
  assert.equal("setRecurringRuleEndDateSchema" in recurringRule, false);
});

test("the live schemas beside them still are", () => {
  assert.equal("debtTermsSchema" in debtTerms, true);
  assert.equal("deleteRecurringRuleSchema" in recurringRule, true);
  assert.equal("pauseRecurringRuleSchema" in recurringRule, true);
});
