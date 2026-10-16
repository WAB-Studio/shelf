// Proves the real `GET /auth/confirm` lands on `landingAfterSignIn(next)`:
// the consent path it came from, and `/` for anything that is not that path.
// Needs a dev server (`PULSAR_BASE_URL`, else the lane's port). No email is
// sent: each case lands a fresh token row by hand.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { adminSql, dropPeople, openCheckRun } from "./lib/people";
import { confirmResponse, createIdentity, landRecoveryToken, sql as mintSql } from "../harness/mint-session";

const admin = adminSql();
const CONSENT = "/oauth/autorizar?client_id=https%3A%2F%2Fapp.example%2Fclient.json&state=abc";

let subject: { id: string; email: string };

async function landing(next: string): Promise<string> {
  const hash = await landRecoveryToken(subject.id, subject.email);
  const response = await confirmResponse(hash, next);
  const location = response.headers.get("location");
  assert.ok(location, `no Location for next=${next} (status ${response.status})`);
  assert.ok(!location.includes("error="), `link refused for next=${next}: ${location}`);
  const url = new URL(location);
  return url.pathname + url.search;
}

async function after_() {
  await dropPeople(admin);
  await mintSql.end();
  await admin.end();
}

before(async () => {
  const runId = await openCheckRun(admin);
  try {
    subject = await createIdentity(runId);
  } catch (error) {
    await after_();
    throw error;
  }
});

after(after_);

test("a consent path in next is where the link lands", async () => {
  assert.equal(await landing(CONSENT), CONSENT);
});

test("a protocol-relative next lands on /", async () => {
  assert.equal(await landing("//evil.example/oauth/autorizar"), "/");
});

test("an absolute foreign next lands on /", async () => {
  assert.equal(await landing("https://evil.example/oauth/autorizar"), "/");
});

test("an own path that is not the consent lands on /", async () => {
  assert.equal(await landing("/metas"), "/");
});
