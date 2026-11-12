import assert from "node:assert/strict";
import { test } from "node:test";

import { inboxPendingCount } from "./inbox-pending";

// Mutation: count the deliveries alone, as the laptop's nav did.
test("Bandeja waits on deliveries and movements to complete together", () => {
  assert.equal(inboxPendingCount({ deliveries: 2, awaitingCounterparty: 3 }), 5);
  assert.equal(inboxPendingCount({ deliveries: 0, awaitingCounterparty: 1 }), 1);
  assert.equal(inboxPendingCount({ deliveries: 0, awaitingCounterparty: 0 }), 0);
});
