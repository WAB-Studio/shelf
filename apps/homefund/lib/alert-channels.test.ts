import assert from "node:assert/strict";
import { test } from "node:test";

import { readAlertChannels, type AlertChannelFacts } from "./alert-channels";

const NOW = new Date("2026-11-17T12:00:00Z");

function fact(accountId: string, lastAlertAt: string | null): AlertChannelFacts {
  return { accountId, accountName: accountId, lastAlertAt, lastVia: lastAlertAt ? "phone" : null, alertsLast30Days: lastAlertAt ? 3 : 0 };
}

const statusOf = (rows: ReturnType<typeof readAlertChannels>, id: string) => rows.find((row) => row.accountId === id)?.status;

test("an account with no alert ever is «never», one with a recent alert is «active»", () => {
  const rows = readAlertChannels([fact("a", null), fact("b", "2026-11-17T10:00:00Z")], NOW);
  assert.equal(statusOf(rows, "a"), "never");
  assert.equal(statusOf(rows, "b"), "active");
});

test("a week of silence warns only while another account keeps receiving", () => {
  const warned = readAlertChannels([fact("a", "2026-11-09T12:00:00Z"), fact("b", "2026-11-16T12:00:00Z")], NOW);
  assert.equal(statusOf(warned, "a"), "silent");
  assert.equal(warned.find((row) => row.accountId === "a")?.daysSince, 8);

  const nobody = readAlertChannels([fact("a", "2026-11-09T12:00:00Z"), fact("b", "2026-11-01T12:00:00Z")], NOW);
  assert.equal(statusOf(nobody, "a"), "quiet");
});

test("six days is still active", () => {
  assert.equal(statusOf(readAlertChannels([fact("a", "2026-11-11T13:00:00Z")], NOW), "a"), "active");
});
