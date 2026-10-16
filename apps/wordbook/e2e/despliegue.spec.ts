import { expect, test } from "./fixtures";

// The one cache `sw.js` is allowed to hold. A name that drifts from the
// worker's own is a spec that measures nothing, so it is read back below
// from `caches.keys()` rather than only asserted against.
const CACHE_NAME = "reading-shell-v13";

// A chunk no build of this app will ever name, standing in for what a
// previous deploy left behind: `cacheFirst` writes every `/_next/static/`
// response and evicts none, so without a sweep this entry outlives every
// deploy on the device.
const STALE_CHUNK = "/_next/static/chunks/OLD-BUILD-CHUNK.js";

const BUILD_KEY = "/__shell-build";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md), which would stall every page load below.
async function deleteTranslator(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function cachedStaticPaths(page: import("@playwright/test").Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    return keys.map((request) => new URL(request.url).pathname);
  }, cacheName);
}

// A device carries one build at a time. The crash this guards against was
// measured on 2026-09-14: a shell cached before RL-28 still answered
// lookups from its own dictionary worker — `{query, exact, viaInflection}`,
// no `correction` — while today's `SenseList` read `answer.correction.length`
// and threw. Nothing in the app ever noticed, because every suite runs one
// build against an empty cache.
test("a deploy retires the previous build's chunks, and a re-open sweeps nothing twice", async ({ page }) => {
  await deleteTranslator(page);

  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });

  // `activate` deletes every cache but its own, so a device that opened an
  // older worker keeps no second pool beside this one.
  const names = await page.evaluate(() => caches.keys());
  expect(names, "one cache, named by the worker in hand").toEqual([CACHE_NAME]);

  // Plant the previous build: its leftover chunk, and the fingerprint the
  // shell that wrote it carried.
  await page.evaluate(
    async ({ cacheName, chunk, buildKey }) => {
      const cache = await caches.open(cacheName);
      await cache.put(chunk, new Response("// a build ago", { headers: { "content-type": "application/javascript" } }));
      await cache.put(buildKey, new Response(chunk));
    },
    { cacheName: CACHE_NAME, chunk: STALE_CHUNK, buildKey: BUILD_KEY },
  );
  expect(await cachedStaticPaths(page, CACHE_NAME)).toContain(STALE_CHUNK);

  // One open of "/" is the whole trigger: the shell that arrives names a
  // different set of scripts, so everything under the old fingerprint goes.
  await page.goto("/");
  // The sweep deletes the stale chunk first and writes the new fingerprint
  // last, so the stale chunk's absence alone marks it half done; the page's
  // own chunks are cached only after, as it asks for them (and a chunk
  // cached before the sweep's listing is swept with the rest).
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ cacheName, buildKey, chunk }) => {
            const stored = await (await caches.open(cacheName)).match(buildKey);
            return stored !== undefined && (await stored.text()) !== chunk;
          },
          { cacheName: CACHE_NAME, buildKey: BUILD_KEY, chunk: STALE_CHUNK },
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect
    .poll(async () => (await cachedStaticPaths(page, CACHE_NAME)).filter((path) => path.startsWith("/_next/static/")).length, {
      timeout: 15_000,
      message: "this build's own chunks are back",
    })
    .toBeGreaterThan(0);
  expect(await cachedStaticPaths(page, CACHE_NAME)).not.toContain(STALE_CHUNK);

  // And the sweep is not a treadmill: a second open of the same build finds
  // its own fingerprint and leaves every entry where it is.
  const fingerprint = await page.evaluate(
    async ({ cacheName, buildKey }) => (await (await caches.open(cacheName)).match(buildKey))?.text() ?? null,
    { cacheName: CACHE_NAME, buildKey: BUILD_KEY },
  );
  expect(fingerprint, "the live shell's own script names").not.toBeNull();

  const before = (await cachedStaticPaths(page, CACHE_NAME)).filter((path) => path.startsWith("/_next/static/"));
  await page.goto("/");
  await page.waitForTimeout(2000);
  const after = (await cachedStaticPaths(page, CACHE_NAME)).filter((path) => path.startsWith("/_next/static/"));
  // A superset, not an equality: a second open still asks for a chunk the
  // first one never reached, and `cacheFirst` writes it. What must not
  // happen is a deletion — the sweep fires only on a fingerprint that moved.
  expect(after.filter((path) => before.includes(path)).sort(), "a matching fingerprint deletes nothing").toEqual(
    [...before].sort(),
  );
});

// ---------------------------------------------------------------------------
// The install itself (RL-16). A deploy changes no byte of `sw.js`, but a
// changed `sw.js` installs a new worker over the cache a previous build left.
// What that install owes the reader is below; none of it may wait for a later
// open of "/" to happen.
// ---------------------------------------------------------------------------

const ASSET_PATTERN = /\/_next\/static\/[^"'\\\s)<>]+?\.(?:js|css|woff2?)/g;

// Every hashed asset the page at `route` names in its HTML, read as the
// browser would receive it.
async function assetsNamedBy(page: import("@playwright/test").Page, route: string): Promise<string[]> {
  const response = await page.request.get(route);
  expect(response.ok(), `${route} answers`).toBe(true);
  return Array.from(new Set((await response.text()).match(ASSET_PATTERN) ?? [])).sort();
}

async function installedWorker(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
}

// Drops the registration, so the next open of the app installs a worker anew
// over whatever the cache holds. The cache itself stays.
async function forgetWorker(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
}

// The fingerprint the contract names: the sorted, de-duplicated script names
// the live "/" carries, comma-joined. Computed here from the network's own
// answer, never read back from what the worker stored.
async function buildOf(page: import("@playwright/test").Page, route: string): Promise<string> {
  const html = await (await page.request.get(route)).text();
  const scripts = html.match(/\/_next\/static\/[^"']+?\.js/g) ?? [];
  return Array.from(new Set(scripts)).sort().join(",");
}

async function storedText(page: import("@playwright/test").Page, key: string): Promise<string | null> {
  return page.evaluate(
    async ({ cacheName, key }) => {
      const hit = await (await caches.open(cacheName)).match(key);
      return hit ? await hit.text() : null;
    },
    { cacheName: CACHE_NAME, key },
  );
}

test("a worker installing over another build's cache retires its chunks before the install ends, and writes its own build", async ({
  page,
}) => {
  await deleteTranslator(page);
  await page.goto("/");
  await installedWorker(page);

  const realBuild = await buildOf(page, "/");
  expect(realBuild).not.toBe("");
  expect(realBuild, "\"/\" and \"/registro\" name different script sets").not.toBe(await buildOf(page, "/registro"));
  expect(await storedText(page, BUILD_KEY), "the first install recorded the build \"/\" names").toBe(realBuild);
  // Every asset any of the app's pages names, so the install has nothing left
  // to fetch: it ends as soon as it has looked, and only an awaited sweep can
  // still be deleting when it does.
  const named = Array.from(
    new Set((await Promise.all(["/", "/registro", "/cuenta", "/registro/_"].map((route) => assetsNamedBy(page, route)))).flat()),
  );
  expect(named.length).toBeGreaterThan(0);

  // Another build's leftovers: one chunk, thousands more so a sweep that
  // is not awaited is still running when the install ends, and this build's
  // own chunk names holding the old build's bytes.
  await page.evaluate(
    async ({ cacheName, buildKey, named }) => {
      const cache = await caches.open(cacheName);
      const old = () => new Response("// a build ago", { headers: { "content-type": "application/javascript" } });
      const puts: Promise<void>[] = [];
      puts.push(cache.put("/_next/static/chunks/OLD-BUILD-CHUNK.js", old()));
      for (let i = 0; i < 3000; i += 1) puts.push(cache.put(`/_next/static/chunks/OLD-${i}.js`, old()));
      for (const asset of named) puts.push(cache.put(asset, old()));
      puts.push(cache.put(buildKey, new Response("OLD-BUILD")));
      await Promise.all(puts);
    },
    { cacheName: CACHE_NAME, buildKey: BUILD_KEY, named },
  );
  await forgetWorker(page);

  // "/" is opened with no worker in control: only `install` can sweep now.
  await page.goto("/");
  await installedWorker(page);

  const state = await page.evaluate(
    async ({ cacheName, named }) => {
      const cache = await caches.open(cacheName);
      const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
      const bytes: Record<string, string> = {};
      for (const asset of named) {
        const hit = await cache.match(asset);
        bytes[asset] = hit ? await hit.text() : "<missing>";
      }
      return { keys, bytes };
    },
    { cacheName: CACHE_NAME, named },
  );
  expect(state.keys.filter((path) => path.includes("/OLD-")), "nothing of the other build survives the install").toEqual(
    [],
  );
  expect(await storedText(page, BUILD_KEY), "the build recorded is the one \"/\" names").toBe(realBuild);
  for (const asset of named) {
    expect(state.bytes[asset], `${asset} is this build's own bytes`).not.toBe("// a build ago");
    expect(state.bytes[asset], `${asset} was stored after the sweep, not lost to it`).not.toBe("<missing>");
  }
});

test("a worker installing over the same build sweeps nothing", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/");
  await installedWorker(page);
  const realBuild = await buildOf(page, "/");
  expect(realBuild, "\"/\" and \"/registro\" name different script sets").not.toBe(await buildOf(page, "/registro"));
  // The cache carries this build's fingerprint, whatever a first install wrote.
  await page.evaluate(
    async ({ cacheName, buildKey, build }) => {
      await (await caches.open(cacheName)).put(buildKey, new Response(build));
    },
    { cacheName: CACHE_NAME, buildKey: BUILD_KEY, build: realBuild },
  );

  // Marker of "kept": a chunk nobody names, under the build the cache already
  // carries. A sweep keyed on any page but "/" reads another script set and
  // takes it.
  await page.evaluate(
    async ({ cacheName }) => {
      await (await caches.open(cacheName)).put("/_next/static/chunks/KEPT.js", new Response("// kept"));
    },
    { cacheName: CACHE_NAME },
  );
  await forgetWorker(page);
  await page.goto("/");
  await installedWorker(page);

  expect(await cachedStaticPaths(page, CACHE_NAME)).toContain("/_next/static/chunks/KEPT.js");
  expect(await storedText(page, BUILD_KEY)).toBe(realBuild);
});

test("the install holds every script, style and font each of the app's pages names, not only the home's", async ({
  page,
}) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await installedWorker(page);

  const routes = ["/", "/registro", "/cuenta", "/registro/_"];
  const named = new Map<string, string[]>();
  for (const route of routes) named.set(route, await assetsNamedBy(page, route));

  const home = new Set(named.get("/"));
  const onlyElsewhere = routes
    .filter((route) => route !== "/")
    .flatMap((route) => named.get(route)!.filter((asset) => !home.has(asset)));
  expect(onlyElsewhere.length, "the other pages name assets the home does not").toBeGreaterThan(0);
  const all = Array.from(new Set(routes.flatMap((route) => named.get(route)!)));
  expect(all.some((asset) => asset.endsWith(".css")), "the build names a stylesheet").toBe(true);
  expect(all.some((asset) => /\.woff2?$/.test(asset)), "the build names a font").toBe(true);

  const cached = new Set(await cachedStaticPaths(page, CACHE_NAME));
  expect(
    all.filter((asset) => !cached.has(asset)),
    "assets a page names that the install left out",
  ).toEqual([]);
});

// A page's own scripts running is what «opens offline» means; its HTML alone
// is a screen that answers nothing. React marks the document it hydrated.
async function hydrated(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => Object.keys(document).some((key) => key.startsWith("__reactContainer")));
}

for (const [visited, opened] of [
  ["/registro", "/cuenta"],
  ["/cuenta", "/registro"],
] as const) {
  test(`only ${visited} visited online: ${opened} opens offline with its own scripts running`, async ({
    page,
    context,
  }) => {
    await deleteTranslator(page);
    // A prefetched payload could answer a tap offline from Chromium's HTTP
    // cache; this test opens by address.
    await page.route(/[?&]_rsc=/, (route) => route.abort());
    await page.goto(visited);
    await installedWorker(page);
    await page.close();

    await context.setOffline(true);
    const offline = await context.newPage();
    await deleteTranslator(offline);
    await offline.route(/[?&]_rsc=/, (route) => route.abort());
    await offline.goto(opened);
    expect(offline.url()).not.toContain("chrome-error:");
    await expect.poll(() => hydrated(offline), { message: `${opened} hydrated from the device` }).toBe(true);
  });
}

test("a chunk that will not fetch does not keep the new worker from installing", async ({ page, context }) => {
  await deleteTranslator(page);
  const named = (await assetsNamedBy(page, "/")).filter((asset) => asset.endsWith(".js"));
  expect(named.length).toBeGreaterThan(1);
  const victim = named[named.length - 1]!;

  // `context.route` also routes the worker's own fetches (docs/TRAPS.md); only
  // the worker's request for this one chunk dies, the page's own goes through.
  await context.route("**/_next/static/**", (route) => {
    if (route.request().serviceWorker() !== null && new URL(route.request().url()).pathname === victim) {
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active !== null), {
      timeout: 20_000,
      message: "the worker activated although one chunk would not come",
    })
    .toBe(true);
  await installedWorker(page);

  const cached = new Set(await cachedStaticPaths(page, CACHE_NAME));
  expect(cached.has(victim), "the chunk that failed is not there").toBe(false);
  expect(
    named.filter((asset) => asset !== victim && !cached.has(asset)),
    "every other chunk still landed",
  ).toEqual([]);
});

// The worker's real source, with a spy in front of it. The spy only records:
// every call `sw.js` makes to the Cache API goes through, and the moment the
// `install` event's own promise settles is stamped. Nothing is stubbed, so
// the order it reports is the order the real code produced.
const INSTALL_SPY = `
self.__log = [];
(() => {
  const log = (entry) => self.__log.push(entry);
  const wrap = (name, tag) => {
    const original = Cache.prototype[name];
    Cache.prototype[name] = function (...args) {
      const first = args[0];
      const url = first instanceof Request ? first.url : first === undefined ? "" : new URL(String(first), self.location.origin).href;
      // Storage that is slow to take the build's fingerprint: an install that
      // does not wait for the sweep ends well before it lands.
      const slow = name === "put" && new URL(url, self.location.origin).pathname === "/__shell-build";
      const done = slow
        ? new Promise((resolve) => setTimeout(resolve, 400)).then(() => original.apply(this, args))
        : original.apply(this, args);
      Promise.resolve(done).then(() => log(tag + " " + new URL(url, self.location.origin).pathname), () => {});
      return done;
    };
  };
  wrap("put", "put");
  wrap("delete", "delete");
  const waitUntil = ExtendableEvent.prototype.waitUntil;
  ExtendableEvent.prototype.waitUntil = function (promise) {
    if (this.type === "install") Promise.resolve(promise).then(() => log("install-settled"), () => log("install-rejected"));
    return waitUntil.call(this, promise);
  };
})();
`;

test("the install does not end until the sweep has retired the other build and written its own", async ({
  page,
  context,
}) => {
  await deleteTranslator(page);
  await context.route("**/sw.js", async (route) => {
    const original = await route.fetch();
    await route.fulfill({
      response: original,
      body: INSTALL_SPY + (await original.text()),
      headers: { ...original.headers(), "content-type": "application/javascript" },
    });
  });
  await page.goto("/");
  await installedWorker(page);

  await page.evaluate(
    async ({ cacheName, buildKey }) => {
      const cache = await caches.open(cacheName);
      const old = () => new Response("// a build ago", { headers: { "content-type": "application/javascript" } });
      const puts: Promise<void>[] = [];
      for (let i = 0; i < 3000; i += 1) puts.push(cache.put(`/_next/static/chunks/OLD-${i}.js`, old()));
      puts.push(cache.put(buildKey, new Response("OLD-BUILD")));
      await Promise.all(puts);
    },
    { cacheName: CACHE_NAME, buildKey: BUILD_KEY },
  );
  await forgetWorker(page);
  await page.goto("/");
  await installedWorker(page);

  const workers = context.serviceWorkers();
  expect(workers.length).toBeGreaterThan(0);
  const log = await workers[workers.length - 1]!.evaluate(() => (self as unknown as { __log: string[] }).__log);

  const settled = log.indexOf("install-settled");
  expect(settled, "the install settled, not rejected").toBeGreaterThanOrEqual(0);
  const deletes = log.filter((entry) => entry.startsWith("delete /_next/static/chunks/OLD-"));
  expect(deletes.length, "the sweep deleted what the other build left").toBe(3000);
  const lastDelete = Math.max(...deletes.map((entry) => log.lastIndexOf(entry)));
  const keyWritten = log.indexOf("put " + BUILD_KEY);
  expect(keyWritten, "the sweep wrote the build it kept").toBeGreaterThanOrEqual(0);
  expect(lastDelete, "every deletion finished before the install did").toBeLessThan(settled);
  expect(keyWritten, "the build was written before the install ended").toBeLessThan(settled);
});
