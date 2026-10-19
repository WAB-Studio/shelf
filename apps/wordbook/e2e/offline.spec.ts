import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { confirmCopy, expect, test } from "./fixtures";
import postgres from "postgres";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";
import { closeRun, openRun } from "@repo/harness-registry";

// `check:e2e` runs the bare Playwright CLI, no `--env-file`: the direct
// Postgres access the session-leak test below needs is not there unless
// this loads it itself (mirrors `e2e/registro.spec.ts`'s own guard).
try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: fall back to whatever the shell already set.
}

// The dictionary's own store holds a manifest once the install has landed.
// Look before opening: opening a database that does not exist yet creates it
// empty at version 1, and the worker's own open then never builds its stores.
async function dictionaryInstalled(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((db) => db.name === "reading-dictionary")) return false;
    return new Promise<boolean>((resolve) => {
      const open = indexedDB.open("reading-dictionary");
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("meta")) {
          db.close();
          resolve(false);
          return;
        }
        const count = db.transaction("meta", "readonly").objectStore("meta").count();
        count.onsuccess = () => {
          db.close();
          resolve(count.result > 0);
        };
        count.onerror = () => {
          db.close();
          resolve(false);
        };
      };
    });
  });
}

test("the app opens with no connection, from its own cache, never the browser's", async ({ page, context }) => {
  // Chromium's built-in `Translator` hangs `availability()` forever
  // (docs/TRAPS.md).
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  await page.goto("/");
  // `activate` calls `self.clients.claim()`, so this page becomes controlled
  // without a second navigation — but only once the worker is actually active.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  // The dictionary on the device is what an offline answer is made of.
  await expect.poll(() => dictionaryInstalled(page)).toBe(true);

  await context.setOffline(true);
  await page.reload();

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await expect(searchBox).toBeVisible();

  // RL-16: the box, not a network error page — Chromium's own offline page
  // never carries this input — and an answer, not an eternal install message.
  await expect(searchBox).toBeEditable();
  await searchBox.fill("apple");
  await expect(page.getByText("manzana, poma", { exact: true })).toBeVisible();
  await expect(page.getByText(messages.install.failed, { exact: true })).toHaveCount(0);

  // The 8.2 MB payload has its own store; the shell's cache must never hold
  // a second copy of it.
  const dictionaryCacheEntries = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      urls.push(...requests.map((request) => request.url));
    }
    return urls.filter((url) => url.includes("/dictionary/"));
  });
  expect(dictionaryCacheEntries).toEqual([]);
});

// Reads every cache the worker owns, never a hardcoded cache name: the
// version string in sw.js is free to change without this test coupling to it.
async function isCached(page: import("@playwright/test").Page, path: string) {
  return page.evaluate(async (p) => {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      if (await cache.match(new URL(p, location.origin).toString())) return true;
    }
    return false;
  }, path);
}

// `/fuente` was this second route until module 10 (RL-33) retired it; the
// claim here was always about the service worker's per-route cache key, not
// about that route itself. `/registro/zzqqxv` replaces it: a real page no
// other lane's assignment holds right now, its word never searched, so it
// always draws the same empty state (e2e/palabra-historial.spec.ts drives
// the same page the same way).
test("a hard load of /registro/zzqqxv does not overwrite the cached / shell", async ({ page, context }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // A hard load of the other route, still online — this used to be the
  // navigation that stomped the single "/" cache entry.
  await page.goto("/registro/zzqqxv");
  await expect.poll(() => isCached(page, "/registro/zzqqxv")).toBe(true);

  await context.setOffline(true);

  // Offline "/": the search box, not the word page the last hard load left
  // in the browser's history.
  await page.goto("/");
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await expect(searchBox).toBeVisible();
  await expect(searchBox).toBeEditable();

  // Offline "/registro/zzqqxv": its own cached page, still reachable — a
  // per-route cache key must not have traded one route's offline support for
  // the other's.
  await page.goto("/registro/zzqqxv");
  await expect(page.getByRole("heading", { name: "zzqqxv" })).toBeVisible();
  await expect(page.getByText(messages.log.word.emptyBody.replace("{word}", "zzqqxv"))).toBeVisible();
});

// Mirrors `e2e/registro.spec.ts`'s own two functions: a fresh `auth.users`
// row with a landed recovery token, the only pair GoTrue's `verifyOtp`
// accepts. Kept local, not imported — a spec's module scope is not the
// place for another file's helpers, and that file has no exports of its own.
async function mintReaderIdentity(
  sql: postgres.Sql,
  runId: string,
): Promise<{ id: string; email: string; hash: string }> {
  const id = randomUUID();
  const email = `harness-reader-${id}@example.invalid`;

  await sql.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;
    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });

  const hash = randomBytes(32).toString("hex");
  await sql`
    update auth.users
    set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${id}`;
  await sql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values
      (${randomUUID()}, ${id}, 'recovery_token', ${hash}, ${email}, now(), now())`;

  return { id, email, hash };
}

async function dropReaderIdentity(sql: postgres.Sql, id: string): Promise<void> {
  await sql`delete from harness.identities where user_id = ${id}`;
  await sql`delete from auth.users where id = ${id}`;
}

// The route's `Set-Cookie` lands on this very redirect, and `page.request`
// shares the browser context's cookie jar, so the context is signed in the
// moment this resolves — no page ever has to visit the link itself. Never
// the `/cuenta` form: that sends a real email from the user's own Gmail.
async function signInAs(page: import("@playwright/test").Page, hash: string): Promise<void> {
  const response = await page.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, {
    maxRedirects: 0,
  });
  const location = response.headers()["location"];
  expect(location?.includes("error="), `redirected to ${location ?? "nowhere"}`).toBe(false);
}

// Drives the leak the coordinator found: `sw.js`'s `NO_OVERWRITE_ROUTES` is
// what stops a live, signed-in render of "/registro" from ever landing in
// Cache Storage — without it, `navigate` overwrites the install-time
// (signed-out) copy the moment a reader visits while signed in, and that
// copy outlives the session it was drawn for.
test("offline, /registro never resurrects the account wipe a signed-in visit once cached", async ({
  page,
  context,
}) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  const reader = await mintReaderIdentity(sql, runId);

  try {
    // Waits for the dictionary asset, same as `e2e/registro.spec.ts`'s own
    // searches: without it the Worker is not ready yet and the fill/clear
    // below never lands a row.
    const assetResponse = page.waitForResponse(
      (response) => response.url().includes(manifest.asset.path) && response.ok(),
    );
    await page.goto("/");
    await assetResponse;
    // aria-busy turns false once the worker has built its index and the install is done.
    await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    // A row this device recorded itself, so `ClearPanel`'s own count gate
    // has something to show once the confirm panel opens.
    const searchBox = page.getByRole("textbox", { name: messages.search.label });
    await searchBox.fill("apple");
    // The row is recorded once the answer paints; clearing first records nothing.
    await expect(page.getByRole("heading", { name: "apple", exact: true })).toBeVisible();
    await searchBox.fill("");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const open = indexedDB.open("reading-log");
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const count = open.result.transaction("lookups", "readonly").objectStore("lookups").count();
                count.onsuccess = () => resolve(count.result);
                count.onerror = () => reject(count.error);
              };
            }),
        ),
      )
      .toBeGreaterThan(0);

    await signInAs(page, reader.hash);

    // A reader whose copy is running (RL-52): the confirm is the only way it starts.
    await page.goto("/cuenta");
    await confirmCopy(page);
    await expect(page.getByText(messages.account.copy.lastCopyMoment, { exact: true })).toBeVisible();

    // Online, signed in: this is the render that must never overwrite the
    // cache — wait for the worker to settle the navigation before reading it.
    await page.goto("/registro");
    await expect(page.getByRole("button", { name: messages.log.clear.trigger })).toBeVisible();
    await expect.poll(() => isCached(page, "/registro")).toBe(true);

    // The session gone, same as a sign-out or an expired cookie — the local
    // record above stays, so `ClearPanel` still has a count to draw from.
    await context.clearCookies();

    await context.setOffline(true);
    await page.goto("/registro");

    await page.getByRole("button", { name: messages.log.clear.trigger }).click();
    await expect(page.getByRole("button", { name: messages.log.clear.accountAction })).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await dropReaderIdentity(sql, reader.id);
    await closeRun(sql);
    await sql.end();
  }
});

// Every `/_next/static/` URL held by any cache this origin owns.
async function cachedChunks(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith("/_next/static/")) urls.push(pathname);
      }
    }
    return urls;
  });
}

// RL-16: a reader whose first online visit was Registro or Cuenta, never `/`,
// must still open `/` offline. The chunks of `/` were never requested while
// the worker controlled the page, so only an install-time precache holds them.
for (const [first, second] of [
  ["/registro", "/cuenta"],
  ["/cuenta", "/registro"],
] as const) {
  test(`offline, / opens with its box when the only online visits were ${first} then ${second}`, async ({
    page,
    context,
  }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { Translator?: unknown }).Translator;
    });
    // The chunks only `/` names. A prefetch from a nav link can race the
    // test and fetch them while the worker controls the page, which is not
    // the reader this test models; abort that race at the page. `page.route`
    // leaves the worker's own requests alone; `context.route` aborts them too.
    const named = async (route: string) =>
      new Set((await (await context.request.get(route)).text()).match(/\/_next\/static\/[^"'\\ ]+?\.(?:js|css)/g) ?? []);
    const [home, registro, cuenta] = await Promise.all([named("/"), named("/registro"), named("/cuenta")]);
    const homeOnly = [...home].filter((chunk) => !registro.has(chunk) && !cuenta.has(chunk));
    // A build whose `/` shares every chunk with the others has nothing to precache: not this test's reader.
    expect(homeOnly.length).toBeGreaterThan(0);
    await page.route(
      (url) => homeOnly.includes(url.pathname),
      (route) => route.abort(),
    );

    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`${error.name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });

    await page.goto(first);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.goto(second);
    // The worker precaches `/` at install; wait for it, never a timer.
    await expect.poll(() => isCached(page, "/")).toBe(true);

    problems.length = 0;
    await page.unroute((url) => homeOnly.includes(url.pathname));
    await context.setOffline(true);
    // The page can hide a missing chunk behind server HTML, so count the
    // chunk requests that nobody answered, not only what is drawn.
    const unanswered: string[] = [];
    page.on("requestfailed", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/_next/static/")) unanswered.push(pathname);
    });
    await page.goto("/");
    await page.waitForLoadState("load");
    expect(unanswered).toEqual([]);

    const searchBox = page.getByRole("textbox", { name: messages.search.label });
    await expect(searchBox).toBeVisible();
    await expect(searchBox).toBeEditable();
    // The box can render from the server HTML alone; typing proves the
    // client bundle of `/` really loaded and hydrated.
    await searchBox.fill("apple");
    await expect(searchBox).toHaveValue("apple");
    // These visits never boot the dictionary (RNL-08), so nothing is installed
    // and no translation can exist. The Worker still loads from the precache
    // and says so, rather than leaving the install message up forever.
    await expect(page.getByText(messages.install.failed, { exact: true })).toBeVisible();
    await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
    await expect(page.getByText(messages.error.title, { exact: true })).toHaveCount(0);
    expect(problems.filter((line) => /ChunkLoadError|Loading chunk|Failed to load chunk/i.test(line))).toEqual([]);
  });
}

// One build at a time: a chunk of a build the shell no longer names must go
// the next time `/` answers online.
test("the cache keeps the chunks of one build after two earlier builds are simulated", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect.poll(() => isCached(page, "/")).toBe(true);

  const stale = ["/_next/static/chunks/zz-build-one.js", "/_next/static/chunks/zz-build-two.js"];
  await page.evaluate(async (paths) => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      if (!(await cache.match(new URL("/", location.origin).toString()))) continue;
      // A build name no real shell carries, so the next `/` reads as a new build.
      await cache.put("/__shell-build", new Response("zz-old-build"));
      for (const p of paths) await cache.put(p, new Response("old", { headers: { "content-type": "text/javascript" } }));
    }
  }, stale);
  expect((await cachedChunks(page)).filter((p) => stale.includes(p)).length).toBeGreaterThan(0);

  await page.goto("/");
  await expect.poll(async () => (await cachedChunks(page)).filter((p) => stale.includes(p))).toEqual([]);
});

// `/cuenta` bakes the signed-in email into its markup; the one copy the
// worker precaches must be the signed-out render even when the tab that
// installs the worker holds a session.
test("the precached /cuenta never carries the email of the session that installed the worker", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  const reader = await mintReaderIdentity(sql, runId);
  try {
    // Signed in before the worker exists, so its install-time fetch could carry the cookie.
    await signInAs(page, reader.hash);
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect.poll(() => isCached(page, "/cuenta")).toBe(true);

    const cached = await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const hit = await (await caches.open(name)).match(new URL("/cuenta", location.origin).toString());
        if (hit) return hit.text();
      }
      return null;
    });
    expect(cached).not.toBeNull();
    expect(cached).not.toContain(reader.email);
  } finally {
    await dropReaderIdentity(sql, reader.id);
    await closeRun(sql);
    await sql.end();
  }
});

// ---------------------------------------------------------------------------
// W5: only a good page is kept, a lookup's address is never stored, and any
// `/?q=` opens offline. Written from the contract, not from `sw.js`.
// ---------------------------------------------------------------------------

type Page = import("@playwright/test").Page;
type Context = import("@playwright/test").BrowserContext;

const SHELL_CACHE = "reading-shell-v13";
const BROKEN = "w5-broken-page-marker";

async function noTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// Every script `/` loaded sits in Cache Storage: the worker's precache has
// finished, so an offline open has its chunks.
async function shellReady(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const scripts = Array.from(document.querySelectorAll("script[src]"))
          .map((s) => new URL((s as HTMLScriptElement).src).pathname)
          .filter((p) => p.startsWith("/_next/static/"));
        for (const p of ["/", "/registro", "/cuenta", "/registro/_", ...scripts]) {
          let hit = false;
          for (const name of await caches.keys()) {
            if (await (await caches.open(name)).match(new URL(p, location.origin).toString())) hit = true;
          }
          if (!hit) return false;
        }
        return true;
      }),
    )
    .toBe(true);
}

// Answers the worker's own fetch of `pathname` (never the page's) with `status`,
// `times` times. `context.route` is what reaches the worker (docs/TRAPS.md).
async function breakWorkerFetch(
  context: Context,
  pathname: string,
  status: number,
  options: { times?: number; headers?: Record<string, string>; body?: string } = {},
): Promise<{ hits: () => number }> {
  let hits = 0;
  const limit = options.times ?? 1;
  await context.route(
    (url) => url.pathname === pathname && url.search === "",
    (route) => {
      if (!route.request().serviceWorker() || hits >= limit) {
        void route.fallback();
        return;
      }
      hits += 1;
      void route.fulfill({
        status,
        headers: { "content-type": "text/html", ...options.headers },
        body: options.body ?? `<html><body>${BROKEN}</body></html>`,
      });
    },
  );
  return { hits: () => hits };
}

async function cachedEntry(page: Page, p: string): Promise<{ status: number; text: string } | null> {
  return page.evaluate(async (p) => {
    for (const name of await caches.keys()) {
      const hit = await (await caches.open(name)).match(new URL(p, location.origin).toString());
      if (hit) return { status: hit.status, text: await hit.text() };
    }
    return null;
  }, p);
}

async function staticKeys(page: Page): Promise<string[]> {
  return (await cachedChunks(page)).sort();
}

// An absence has no event to wait for: the page has already shown the
// network's answer (the worker's `put` is issued before that), then the cache
// is read repeatedly for as long as a slow `put`/sweep could still land.
async function staysTrue(check: () => Promise<boolean>, windowMs = 1500): Promise<boolean> {
  const end = Date.now() + windowMs;
  do {
    if (!(await check())) return false;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  return true;
}

async function expectBox(page: Page): Promise<void> {
  const box = page.getByRole("textbox", { name: messages.search.label });
  await expect(box).toBeVisible();
  await expect(box).toBeEditable();
}

test("W5: the worker holds one cache, named reading-shell-v13", async ({ page }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  expect(await page.evaluate(() => caches.keys())).toEqual([SHELL_CACHE]);
});

test("W5: a 503 on / online reaches the page but does not replace the cached shell", async ({ page, context }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  const broken = await breakWorkerFetch(context, "/", 503);

  await page.reload();
  await expect(page.getByText(BROKEN)).toBeVisible();
  expect(broken.hits()).toBe(1);

  expect(await staysTrue(async () => (await cachedEntry(page, "/"))?.status === 200)).toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.getByText(BROKEN)).toHaveCount(0);
  await expectBox(page);
});

test("W5: a 500 on /registro/<word> online does not become what opens offline", async ({ page, context }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  await breakWorkerFetch(context, "/registro/zzqq", 500);

  await page.goto("/registro/zzqq");
  await expect(page.getByText(BROKEN)).toBeVisible();

  expect(await staysTrue(async () => (await cachedEntry(page, "/registro/zzqq"))?.status !== 500)).toBe(
    true,
  );
  await context.setOffline(true);
  await page.goto("/registro/zzqq");
  await expect(page.getByText(BROKEN)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "zzqq" })).toBeVisible();
});

test("W5: a 503 on / never sweeps the chunks of the build in hand", async ({ page, context }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  const before = await staticKeys(page);
  expect(before.length).toBeGreaterThan(0);

  // A page naming other scripts reads as a new build to the sweep.
  await breakWorkerFetch(context, "/", 503, {
    body: `<html><body>${BROKEN}<script src="/_next/static/chunks/w5-other-build.js"></script></body></html>`,
  });
  await page.reload();
  await expect(page.getByText(BROKEN)).toBeVisible();

  expect(await staysTrue(async () => (await staticKeys(page)).join() === before.join())).toBe(true);
});

test("W5: a response the server redirected is not what opens / offline", async ({ page, context }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  await breakWorkerFetch(context, "/", 307, { headers: { location: "/cuenta" }, body: "" });

  await page.goto("/");
  await page.waitForLoadState("load");

  expect(await staysTrue(async () => {
    const hit = await cachedEntry(page, "/");
    return hit !== null && hit.status === 200;
  })).toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  await expectBox(page);
});

test("W5: /?q=<word> is never written to Cache Storage", async ({ page }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);

  await page.goto("/?q=book");
  await expect(page.getByRole("heading", { name: "book", exact: true })).toBeVisible();

  expect(await page.evaluate(() => caches.keys())).toEqual([SHELL_CACHE]);
  const searched = async () =>
    page.evaluate(async () => {
      const keys: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          if (new URL(request.url).search.startsWith("?q=")) keys.push(request.url);
        }
      }
      return keys;
    });
  expect(await staysTrue(async () => (await searched()).length === 0)).toBe(true);
});

test("W5: offline, /?q=apple opens with apple's answer though it was never visited online", async ({
  page,
  context,
}) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  await expect.poll(() => dictionaryInstalled(page)).toBe(true);

  await context.setOffline(true);
  await page.goto("/?q=apple");
  await expect(page.getByText("manzana, poma", { exact: true })).toBeVisible();
  await expect(page.getByText(messages.install.failed, { exact: true })).toHaveCount(0);
});

test("W5: offline, /?q=book still answers book when it was visited online first", async ({ page, context }) => {
  await noTranslator(page);
  await page.goto("/");
  await shellReady(page);
  await expect.poll(() => dictionaryInstalled(page)).toBe(true);
  // Controlled by the worker now: this is the visit the worker may see.
  await page.goto("/?q=book");
  await expect(page.getByRole("heading", { name: "book", exact: true })).toBeVisible();

  await context.setOffline(true);
  await page.goto("/?q=book");
  await expect(page.getByRole("heading", { name: "book", exact: true })).toBeVisible();
});

test("W5: an install whose /cuenta answers 500 skips it, completes, and / opens offline", async ({
  page,
  context,
}) => {
  await noTranslator(page);
  const broken = await breakWorkerFetch(context, "/cuenta", 500, { times: 1 });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect.poll(() => isCached(page, "/")).toBe(true);
  await expect.poll(() => isCached(page, "/registro/_")).toBe(true);
  expect(broken.hits()).toBe(1);

  const cuenta = await cachedEntry(page, "/cuenta");
  expect(cuenta === null || cuenta.status === 200, `cached /cuenta status ${cuenta?.status}`).toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  await expectBox(page);
});
