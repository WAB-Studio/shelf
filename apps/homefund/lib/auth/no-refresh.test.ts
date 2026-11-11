import assert from "node:assert/strict";
import { test } from "node:test";

import { neverRefreshFetch } from "./no-refresh";

test("RF-190: a refresh grant is refused without reaching Auth", async () => {
  let reached = 0;
  const fetch = neverRefreshFetch((async () => {
    reached += 1;
    return new Response("{}");
  }) as typeof globalThis.fetch);

  const answer = await fetch("https://x.supabase.co/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: "t" }),
  });

  assert.equal(answer.status, 400);
  assert.equal(reached, 0);
});

test("RF-190: every other call goes through", async () => {
  let reached = 0;
  const fetch = neverRefreshFetch((async () => {
    reached += 1;
    return new Response("{}");
  }) as typeof globalThis.fetch);

  await fetch("https://x.supabase.co/auth/v1/user");
  await fetch("https://x.supabase.co/auth/v1/token?grant_type=pkce");

  assert.equal(reached, 2);
});
