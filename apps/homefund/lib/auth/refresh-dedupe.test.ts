import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedRefreshFetch } from "./refresh-dedupe";

const URL_REFRESH = "https://x.supabase.co/auth/v1/token?grant_type=refresh_token";

function refreshInit(token: string): RequestInit {
  return { method: "POST", body: JSON.stringify({ refresh_token: token }) };
}

function counting(status = 200) {
  const calls: string[] = [];
  const base = (async (_input: unknown, init?: RequestInit) => {
    calls.push(String(init?.body));
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ refresh_token: `next-${calls.length}` }), { status });
  }) as typeof fetch;

  return { calls, fetch: sharedRefreshFetch(base) };
}

test("RF-190: concurrent refreshes of one token reach Auth once and share its answer", async () => {
  const { calls, fetch } = counting();
  const answers = await Promise.all([1, 2, 3].map(() => fetch(URL_REFRESH, refreshInit("same-token"))));

  assert.equal(calls.length, 1);
  const bodies = await Promise.all(answers.map((answer) => answer.text()));
  assert.deepEqual(new Set(bodies).size, 1);
});

test("RF-190: two different tokens are two refreshes", async () => {
  const { calls, fetch } = counting();
  await Promise.all([fetch(URL_REFRESH, refreshInit("a-token")), fetch(URL_REFRESH, refreshInit("b-token"))]);

  assert.equal(calls.length, 2);
});

test("RF-190: a refusal is not remembered", async () => {
  const { calls, fetch } = counting(400);
  const first = await fetch(URL_REFRESH, refreshInit("refused-token"));
  await fetch(URL_REFRESH, refreshInit("refused-token"));

  assert.equal(first.status, 400);
  assert.equal(calls.length, 2);
});

test("RF-190: any other call goes straight through", async () => {
  const { calls, fetch } = counting();
  await fetch("https://x.supabase.co/auth/v1/user", { method: "GET" });
  await fetch("https://x.supabase.co/auth/v1/user", { method: "GET" });

  assert.equal(calls.length, 2);
});
