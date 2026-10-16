import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import { isDomainDeliverable } from "../app/actions/account";
import messages from "../messages/es.json";

// `sendSignInLink` (app/actions/account.ts) is a Server Action: the browser
// calls it over a POST to the current page with a `next-action` header, and
// gets back a Flight-encoded return value — not a plain fetch a route handler
// answers. Faking that second line is what lets this suite drive a 429 (and
// a generic failure) without ever asking Supabase for a real one, which
// would spend the address's real send quota (RL-22's own action already
// logs and classifies the real thing; this proves what the reader sees for
// each of the three outcomes `SignedOutForm` can render).
async function mockSendSignInLinkResult(page: Page, result: { ok: true } | { ok: false; error: string }): Promise<void> {
  await page.route("**/cuenta", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = [
      '0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}',
      `1:${JSON.stringify(result)}`,
      "",
    ].join("\n");
    await route.fulfill({ status: 200, contentType: "text/x-component", body });
  });
}

// THE RULE: no test in this file may run the real `sendSignInLink`. The guard
// in `app/actions/account.ts` fails open on a DNS error, so a send that
// reaches it on a machine without DNS mails a real address and mints an
// `auth.users` row. Every action POST goes through the route below unless a
// test installed its own (the latest-registered route wins), and one that
// slips through is aborted before it leaves the browser and fails the test.
const RULE_MESSAGE =
  "sendSignInLink POST left the browser with no simulated answer: account-send-link.spec.ts never runs the real action";

let unsimulatedPosts: string[] = [];

test.beforeEach(async ({ page }) => {
  unsimulatedPosts = [];
  await page.route("**/cuenta", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) {
      await route.continue();
      return;
    }
    unsimulatedPosts.push(request.url());
    await route.abort();
  });
});

test.afterEach(() => {
  expect(unsimulatedPosts, RULE_MESSAGE).toEqual([]);
});

async function submit(page: Page, email: string): Promise<void> {
  await page.goto("/cuenta");
  await page.getByRole("textbox", { name: messages.account.emailLabel }).fill(email);
  await page.getByRole("button", { name: messages.account.copy.noSessionAction }).click();
}

// Waits for the browser to report the action POST as failed. A POST that
// reached a server would answer instead, so only an abort lands here.
function nextActionPostFailure(page: Page): Promise<{ hasResponse: boolean }> {
  return new Promise((resolve) => {
    page.on("requestfailed", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        void request.response().then((response) => resolve({ hasResponse: response !== null }));
      }
    });
  });
}

// The abort itself, observed from the browser and apart from the guard's
// bookkeeping. The address has no `@`, so even with the abort removed the
// real action would refuse it before any DNS or Supabase call, no request
// would fail, and this test would time out red.
test("the guard aborts an action POST that has no simulated answer", async ({ page }) => {
  const failure = nextActionPostFailure(page);
  await submit(page, "sentinel-no-at-sign");

  expect(await failure).toEqual({ hasResponse: false });
  expect(unsimulatedPosts).toHaveLength(1);
  // Consumed: `afterEach` would otherwise fail this test for the very POST it asserts.
  unsimulatedPosts = [];
});

// Fails by design (`test.fail`): nothing in the body asserts, so only
// `afterEach` can fail it. If that check goes, this test turns red.
test("a test that lets the action POST out unsimulated fails", async ({ page }) => {
  test.fail();
  const failure = nextActionPostFailure(page);
  await submit(page, "sentinel-no-at-sign");
  await failure;
});

test("a 429 asking for the link says to wait, not the generic failure", async ({ page }) => {
  await mockSendSignInLinkResult(page, { ok: false, error: "rateLimited" });
  await submit(page, "reader@example.com");

  await expect(page.getByText(messages.account.errors.rateLimited)).toBeVisible();
  await expect(page.getByText(messages.account.errors.sendFailed)).toHaveCount(0);
});

test("a non-429 failure still says the generic 'could not send', not the rate-limit copy", async ({ page }) => {
  await mockSendSignInLinkResult(page, { ok: false, error: "sendFailed" });
  await submit(page, "reader@example.com");

  await expect(page.getByText(messages.account.errors.sendFailed)).toBeVisible();
  await expect(page.getByText(messages.account.errors.rateLimited)).toHaveCount(0);
});

test("an invalid-email answer keeps its own copy", async ({ page }) => {
  await mockSendSignInLinkResult(page, { ok: false, error: "emailInvalid" });
  await submit(page, "not-an-email");

  await expect(page.getByText(messages.account.errors.emailInvalid)).toBeVisible();
  await expect(page.getByText(messages.account.errors.rateLimited)).toHaveCount(0);
});

// Driven on a production build, `context.setOffline(true)` does not hang
// this POST — it rejects it at once, `TypeError: Failed to fetch`, which
// `route.abort("internetdisconnected")` reproduces exactly (same Chromium
// network error) with no request ever reaching the real network.
async function abortSendSignInLink(page: Page): Promise<void> {
  await page.route("**/cuenta", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.abort("internetdisconnected");
  });
}

test("no network: the button gives up, names the connection, keeps the email, and a retry sends", async ({
  page,
  context,
}) => {
  // Loaded and filled while still online: the defect this proves is the
  // send itself failing, never the page load.
  const email = "reader@example.com";
  await page.goto("/cuenta");
  const emailField = page.getByRole("textbox", { name: messages.account.emailLabel });
  await emailField.fill(email);

  await abortSendSignInLink(page);
  // Belt and braces: the route above already keeps the request from
  // leaving the browser, and this names the real defect it stands in for.
  await context.setOffline(true);

  const tappedAt = Date.now();
  await page.getByRole("button", { name: messages.account.copy.noSessionAction }).click();

  await expect(page.getByText(messages.account.errors.offline, { exact: true })).toBeVisible({ timeout: 15_000 });
  console.log(`account-send-link offline: failure line after ${Date.now() - tappedAt}ms`);

  // Three states, not two: neither of the other two lines shows instead.
  // Exact match: the offline line's own text contains `sendFailed`'s whole
  // string, so a substring search would find it inside the right line.
  await expect(page.getByText(messages.account.errors.sendFailed, { exact: true })).toHaveCount(0);
  await expect(page.getByText(messages.account.errors.rateLimited, { exact: true })).toHaveCount(0);

  // Nobody retypes it, and the button is pulsable again under its own name.
  await expect(emailField).toHaveValue(email);
  const retryButton = page.getByRole("button", { name: messages.account.retry });
  await expect(retryButton).toBeEnabled();

  // The rejected first request already settled Next's own action queue
  // (RL-22 dispatches Server Actions one at a time per client) — the most
  // recently registered route wins from here (Playwright's own rule), so
  // the retry's fresh POST answers `ok: true` clean.
  await mockSendSignInLinkResult(page, { ok: true });
  await context.setOffline(false);
  await retryButton.click();

  await expect(page.getByText(messages.account.sent)).toBeVisible();
});

// The clock in `SEND_LINK_TIMEOUT_MS` is the second line of defence, for a
// request that truly never settles rather than failing fast — a shape
// `route.abort` above cannot produce. This proves only that the failure
// line still shows up in that case; a request genuinely stuck forever also
// stalls Next's own action queue behind it, so this does not claim retry.
test("a request that never settles still gives up, on the clock rather than the rejection", async ({ page }) => {
  await page.route("**/cuenta", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await new Promise(() => {});
  });

  const email = "reader@example.com";
  await page.goto("/cuenta");
  await page.getByRole("textbox", { name: messages.account.emailLabel }).fill(email);

  const tappedAt = Date.now();
  await page.getByRole("button", { name: messages.account.copy.noSessionAction }).click();

  await expect(page.getByText(messages.account.errors.offline, { exact: true })).toBeVisible({ timeout: 15_000 });
  console.log(`account-send-link never-settles: failure line after ${Date.now() - tappedAt}ms`);
});

test("on a real connection the happy path is unchanged: no wait for the offline clock", async ({ page }) => {
  await mockSendSignInLinkResult(page, { ok: true });
  await submit(page, "reader@example.com");

  // Well inside `SEND_LINK_TIMEOUT_MS`: a working request must never wait on
  // the offline clock to answer.
  await expect(page.getByText(messages.account.sent)).toBeVisible({ timeout: 2_000 });
});

// The dead-domain screen is driven with the action's answer simulated: the
// real action would resolve DNS and, where DNS fails, send for real. The
// guard itself is proved by calling `isDomainDeliverable` directly, below.
//
// NEVER disable that guard while any test here submits the form. It is the
// only thing between a send and a live Supabase: it mints an `auth.users` row
// and mails the user's own Gmail, which bounces back to their inbox. It
// happened on 2026-09-10.
test("a dead-domain answer paints its own copy, and neither of the other two", async ({ page }) => {
  await mockSendSignInLinkResult(page, { ok: false, error: "domainUndeliverable" });
  await submit(page, "reader@example.com");

  await expect(page.getByText(messages.account.errors.domainUndeliverable)).toBeVisible();
  await expect(page.getByText(messages.account.errors.sendFailed)).toHaveCount(0);
  await expect(page.getByText(messages.account.errors.rateLimited)).toHaveCount(0);
});

test("a domain with a null MX (RFC 7505) is not deliverable", async () => {
  // `example.com`: RFC 7505 §6 gives it as the null-MX example.
  await expect(isDomainDeliverable("example.com")).resolves.toBe(false);
});

test("a domain with no DNS records at all is not deliverable", async () => {
  await expect(isDomainDeliverable("asdkjhqwe-no-existe-1234.com")).resolves.toBe(false);
});

// The acceptance path is proved against `isDomainDeliverable` directly, not
// through `submit`: calling the action for a domain the check lets through
// would ask Supabase for a real send, spending the project's send quota and
// (for an address Supabase has never seen) leaving a row in `auth.users`.
test("a domain with no MX but an A record is deliverable (RFC 5321 §5.1's implicit MX)", async () => {
  // GitHub's raw-content host: publishes A/AAAA, no MX (confirmed live,
  // 2026-09-10 — `dns.resolveMx` answers `ENODATA`).
  await expect(isDomainDeliverable("raw.githubusercontent.com")).resolves.toBe(true);
});

test("an ordinary domain with a real MX is deliverable", async () => {
  await expect(isDomainDeliverable("gmail.com")).resolves.toBe(true);
});

test("a resolver error that is not 'no such record' fails open (today's behaviour, not a promise)", async () => {
  const brokenResolvers = {
    resolveMx: () => Promise.reject(Object.assign(new Error("queryMx ESERVFAIL"), { code: "ESERVFAIL" })),
    resolve4: () => Promise.reject(Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" })),
    resolve6: () => Promise.reject(Object.assign(new Error("queryAaaa ESERVFAIL"), { code: "ESERVFAIL" })),
  };

  await expect(isDomainDeliverable("broken-resolver.invalid", brokenResolvers)).resolves.toBe(true);
});

test("a resolver that never answers still gives an answer, on its own clock", async () => {
  const hangingResolvers = {
    resolveMx: () => new Promise<never>(() => {}),
    resolve4: () => new Promise<never>(() => {}),
    resolve6: () => new Promise<never>(() => {}),
  };

  const startedAt = Date.now();
  const result = await isDomainDeliverable("never-answers.invalid", hangingResolvers);
  const elapsedMs = Date.now() - startedAt;
  console.log(`isDomainDeliverable hanging resolver: answered after ${elapsedMs}ms`);

  expect(result).toBe(true);
  // Bounded by its own timeout, not by the resolver's silence, and still
  // under `SEND_LINK_TIMEOUT_MS` (8s). The margin over `DNS_TIMEOUT_MS`
  // (2.5s) is event-loop delay, not the check waiting: with three suites on
  // this machine the same call answered after 5290ms (2026-09-14).
  expect(elapsedMs).toBeLessThan(7_000);
});
