import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import type { Page } from "@playwright/test";
import postgres from "postgres";

import { closeRun, openRun } from "@repo/harness-registry";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { LookupRecord, SyncState } from "../lib/log/types";
import manifest from "../public/dictionary/manifest.json";
import { COPY_CONFIRM_LABEL, confirmCopy, expect, test } from "./fixtures";

// Module 526, RL-52: with a session open, nothing leaves the device until the
// reader taps «Empezar a copiar». Written from `private/plan-voyager-auditoria.md`
// (Done table of 526) and the words the user approved on 2026-10-08, not from
// the components.
//
// Keys the worker adds to `messages/es.json` (the literals below are the
// approved text until they exist):
//   account.copy.confirmTitle   «Copiar tu registro a {email}»
//   account.copy.confirmBody    «Hasta que lo confirmes, nada sale de este dispositivo.»
//   account.copy.confirmAction  «Empezar a copiar»
//   account.copy.failedBodyFirst «Tus palabras siguen en este dispositivo.»
//   account.copy.retiredTitle   «Este dispositivo ya no copia»
//   account.copy.retiredBody    «Lo retiraste de tu cuenta y tu registro se quedó completo aquí. …»
//   account.devices.confirmBodyOwn / confirmBodyLastDevice  (rewritten)
//   account.devices.label       «{browser} en {platform}»
//   account.devices.labelUnknown «Dispositivo desconocido»
//
// Never types an address into /cuenta: the session enters through the harness
// (`/auth/confirm` with a landed token), as `sync.spec.ts` does.

try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

const confirmTitle = (email: string) => `Copiar tu registro a ${email}`;
const CONFIRM_BODY = "Hasta que lo confirmes, nada sale de este dispositivo.";
const FAILED_BODY_FIRST = "Tus palabras siguen en este dispositivo.";
const RETIRED_TITLE = "Este dispositivo ya no copia";
const RETIRED_BODY =
  "Lo retiraste de tu cuenta y tu registro se quedó completo aquí. Para copiarlo de nuevo, cierra sesión y vuelve a entrar.";
const OWN_BODY =
  "Además, este dispositivo deja de copiar: tu registro se queda completo aquí. Para copiarlo de nuevo, cierra sesión y vuelve a entrar.";
const LAST_DEVICE_BODY =
  "Es tu único dispositivo copiando: la copia de tu cuenta queda vacía. Tu registro se queda entero aquí.";
const UNKNOWN_DEVICE = "Dispositivo desconocido";

type Reader = { id: string; email: string };
type SyncPost = { deviceId: string; since: string | null; rows: unknown[] };
type SeedLookup = Omit<LookupRecord, "id">;

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// Every POST the page issues to the copy route, read off the `request` event:
// a request the route later aborts or holds still counts.
function trackSync(page: Page): SyncPost[] {
  const posts: SyncPost[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/log/sync") && request.method() === "POST") {
      posts.push(request.postDataJSON() as SyncPost);
    }
  });
  return posts;
}

async function landToken(sql: postgres.Sql, reader: Reader): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  await sql`
    update auth.users
    set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${reader.id}`;
  await sql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values
      (${randomUUID()}, ${reader.id}, 'recovery_token', ${hash}, ${reader.email}, now(), now())`;
  return hash;
}

async function mintReader(sql: postgres.Sql, runId: string): Promise<Reader> {
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
  return { id, email };
}

async function signInWith(page: Page, hash: string): Promise<void> {
  const response = await page.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, {
    maxRedirects: 0,
  });
  const location = response.headers()["location"];
  expect(location?.includes("error="), `redirected to ${location ?? "nowhere"}`).toBe(false);
}

// A reader signed in on this page's context, torn down afterwards.
async function withReader(
  page: Page,
  body: (ctx: { sql: postgres.Sql; reader: Reader; signIn: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  const reader = await mintReader(sql, runId);
  try {
    await body({
      sql,
      reader,
      signIn: async () => signInWith(page, await landToken(sql, reader)),
    });
  } finally {
    await sql`delete from harness.identities where user_id = ${reader.id}`;
    await sql`delete from auth.users where id = ${reader.id}`;
    await closeRun(sql);
    await sql.end();
  }
}

function localRow(text: string, extra: Partial<SeedLookup> = {}): SeedLookup {
  return {
    schema: 2,
    at: Date.now(),
    text,
    normalised: text,
    kind: "word",
    outcome: "miss",
    headword: null,
    rule: null,
    senses: 0,
    translation: null,
    dictionaryReady: true,
    origin: null,
    ...extra,
  };
}

// `/registro` never reads `sync`, so seeding from it cannot race /cuenta's own
// mount. Mirrors `sync.spec.ts`'s `seedLocalDatabase`.
// Seeded from `/`: `/registro` fires a round on open that would race this
// write and put a fresh copy over the seeded one.
async function seedLocal(page: Page, rows: { sync?: SyncState; lookups?: SeedLookup[] }): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
  await page.evaluate(
    ({ version, sync, lookups }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log", version);
        request.onupgradeneeded = (event) => {
          const database = request.result;
          if (event.oldVersion < 1) {
            const store = database.createObjectStore("lookups", { keyPath: "id", autoIncrement: true });
            store.createIndex("at", "at");
            store.createIndex("normalised", "normalised");
          }
          if (event.oldVersion < 2) {
            database.createObjectStore("sync", { keyPath: "key" });
            request.transaction!
              .objectStore("lookups")
              .createIndex("foreign", ["device", "deviceSeq"], { unique: true });
          }
          if (event.oldVersion < 3) {
            request.transaction!.objectStore("lookups").createIndex("headword", "headword");
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["lookups", "sync"], "readwrite");
          if (sync) tx.objectStore("sync").put({ ...sync, key: "state" });
          for (const row of lookups ?? []) tx.objectStore("lookups").add(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { version: DATABASE_VERSION, sync: rows.sync ?? null, lookups: rows.lookups ?? [] },
  );
}

async function readSync(page: Page): Promise<SyncState | undefined> {
  return page.evaluate(
    () =>
      new Promise<SyncState | undefined>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction("sync", "readonly").objectStore("sync").get("state");
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
  );
}


const copy = messages.account.copy;
// «Copiando a tu cuenta» / «Al día…» left the done state (module 547); the
// literals stand because the catalog keys go with them.
const GONE_TITLE = "Copiando a tu cuenta";
const GONE_BODY = /Al día/;

function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

// The ICU plural of `syncingSearches`, read off the catalog's own three forms.
function searchesLine(count: number): string {
  const forms = Object.fromEntries(
    [...copy.syncingSearches.matchAll(/(=0|one|other) \{([^}]*)\}/g)].map((m) => [m[1], m[2]]),
  );
  const form = count === 0 ? forms["=0"]! : count === 1 ? forms["one"]! : forms["other"]!;
  return form.replace("#", String(count));
}

async function expectDone(page: Page): Promise<void> {
  await expect(page.getByText(copy.lastCopyMoment, { exact: true })).toBeVisible();
  await expect(page.getByText(GONE_TITLE)).toHaveCount(0);
  await expect(page.getByText(GONE_BODY)).toHaveCount(0);
}

// A copy this reader already confirmed, five minutes old, nothing pushed yet.
function confirmedFor(reader: Reader, extra: Partial<SyncState> = {}): SyncState {
  return {
    deviceId: randomUUID(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: Date.now() - 5 * 60_000,
    enabled: true,
    readerId: reader.id,
    retired: false,
    ...extra,
  };
}

async function countLookups(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const count = db.transaction("lookups", "readonly").objectStore("lookups").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
      }),
  );
}

const confirmButton = (page: Page) => page.getByRole("button", { name: COPY_CONFIRM_LABEL });

// The copy done and this device sealed in the list, ready to be retired.
async function copyAndSeal(page: Page, reader: Reader): Promise<void> {
  await page.goto("/cuenta");
  await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
  const done = page.waitForResponse((r) => r.url().includes("/api/log/sync"));
  await confirmCopy(page);
  expect((await done).status()).toBe(200);
  await expect(page.getByText(messages.account.devices.thisDevice)).toBeVisible();
}

async function retireOwnDevice(page: Page): Promise<void> {
  await page.getByRole("button", { name: messages.account.devices.retire, exact: true }).click();
  const deleted = page.waitForResponse(
    (r) => r.url().includes("/api/devices") && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: messages.account.devices.confirm }).click();
  expect((await deleted).status()).toBe(200);
}

test.beforeEach(async ({ page }) => {
  await deleteTranslator(page);
});

test("RL-52: a session with no confirmation shows the address and the button, and sends nothing, not even on hide", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    const posts = trackSync(page);
    await page.goto("/cuenta");

    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await expect(page.getByText(CONFIRM_BODY)).toBeVisible();
    await expect(confirmButton(page)).toBeVisible();
    // The address shows once: the title carries it, `signedInAs` is not painted here.
    const shown = (await page.locator("body").innerText()).split(reader.email).length - 1;
    expect(shown, `the address appears ${shown} times`).toBe(1);
    await expect(page.getByText(messages.account.signedInAs.split("{email}")[0]!.trim())).toHaveCount(0);
    // A first reader on a clean device has no «other reader» to be told about.
    await expect(page.getByText(copy.otherReader, { exact: true })).toHaveCount(0);
    // The «done» state is not drawn before anyone confirmed.
    await expect(page.getByText(GONE_TITLE)).toHaveCount(0);

    await page.waitForTimeout(3000);
    expect(posts, `POSTs while waiting: ${JSON.stringify(posts)}`).toHaveLength(0);

    await hideTab(page);
    await page.waitForTimeout(1500);
    expect(posts, `POSTs after hide: ${JSON.stringify(posts)}`).toHaveLength(0);

    const row = await readSync(page);
    expect(row?.enabled ?? false, `sync row: ${JSON.stringify(row)}`).toBe(false);
  });
});

test("RL-52: /cuenta reads Copia, Dispositivos, Cerrar sesión, top to bottom", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ signIn }) => {
    await signIn();
    await page.goto("/cuenta");
    const top = async (locator: ReturnType<Page["getByText"]>) => {
      await expect(locator).toBeVisible();
      return (await locator.boundingBox())!.y;
    };
    const copia = await top(page.getByText(messages.account.copy.label, { exact: true }));
    const devices = await top(page.getByText(messages.account.devices.title, { exact: true }));
    const signOut = await top(page.getByRole("button", { name: messages.account.signOut }));
    expect(copia, "Copia above Dispositivos").toBeLessThan(devices);
    expect(devices, "Dispositivos above Cerrar sesión").toBeLessThan(signOut);
  });
});

test("RL-52: tapping the button sends exactly one POST and the button is gone while it copies", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { lookups: [localRow("alpha"), localRow("beta"), localRow("gamma")] });
    await signIn();
    const posts = trackSync(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/log/sync", async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto("/cuenta");
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();

    await confirmButton(page).dblclick();
    await expect(page.getByText(searchesLine(3), { exact: true })).toBeVisible();
    await expect(confirmButton(page)).toHaveCount(0);
    // The same title stays while it copies (board CuentaCopiaConfirmarEnCurso).
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();

    release();
    await expectDone(page);
    await page.waitForTimeout(500);
    expect(posts, `POSTs for one tap: ${JSON.stringify(posts)}`).toHaveLength(1);
  });
});

test("RL-52, RNL-09: after the copy, the done state shows and the next POST leaves on hide", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    const posts = trackSync(page);
    await page.goto("/cuenta");
    await expect(confirmButton(page)).toBeVisible();

    await confirmCopy(page);
    await expectDone(page);
    await expect(confirmButton(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);

    const row = await readSync(page);
    expect(row?.enabled, `sync row: ${JSON.stringify(row)}`).toBe(true);
    expect(row?.readerId).toBe(reader.id);

    const next = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
    await hideTab(page);
    await next;
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(2);
  });
});

test("RL-52: a server error names our side, keeps the retry, and retrying sends one POST", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    const posts = trackSync(page);
    let failing = true;
    await page.route("**/api/log/sync", (route) =>
      failing
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
        : route.continue(),
    );

    await page.goto("/cuenta");
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await confirmCopy(page);

    await expect(page.getByText(copy.failedServer, { exact: true })).toBeVisible();
    await expect(page.getByText(/Sin conexión/)).toHaveCount(0);
    await expect(page.getByText(copy.failedQuotaTitle)).toHaveCount(0);
    await expect(confirmButton(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);

    failing = false;
    await page.getByRole("button", { name: copy.failedAction }).click();
    await expectDone(page);
    await page.waitForTimeout(500);
    expect(posts, `POSTs after one retry: ${JSON.stringify(posts)}`).toHaveLength(2);
  });
});

test("RL-52: the first copy that cannot reach the server says the words stay here, with no «hace»", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    await page.route("**/api/log/sync", (route) => route.abort("connectionfailed"));
    await page.goto("/cuenta");
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await confirmCopy(page);

    await expect(page.getByText(copy.failedOfflineTitle, { exact: true })).toBeVisible();
    // Exact: `failedOffline` and `failedServer` both contain this sentence.
    await expect(page.getByText(FAILED_BODY_FIRST, { exact: true })).toBeVisible();
    await expect(page.getByText(/desde hace/)).toHaveCount(0);
    await expect(page.getByText(copy.failedServer, { exact: true })).toHaveCount(0);
  });
});

test("RL-52: a copy cut by the network says since when", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: Date.now() - 3 * 60_000 }) });
    await signIn();
    let failing = true;
    await page.route("**/api/log/sync", (route) =>
      failing
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
        : route.continue(),
    );
    await page.goto("/cuenta");
    // The opening pull fails on our side; then the line drops for the retry.
    await expect(page.getByText(copy.failedServer, { exact: true })).toBeVisible();
    failing = false;
    await page.context().setOffline(true);
    try {
      await page.getByRole("button", { name: copy.failedAction }).click();
      await expect(
        page.getByText(fillTemplate(copy.failedOffline, { time: "3 minutos" }), { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(copy.failedOfflineTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(copy.failedServer, { exact: true })).toHaveCount(0);
    } finally {
      await page.context().setOffline(false);
    }
  });
});

test("RL-52, RNL-02: a 30-second-old copy reads «hace un momento» or its own words, never «1 minuto»", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: Date.now() - 30_000 }) });
    await signIn();
    await page.route("**/api/log/sync", (route) => route.abort("connectionfailed"));
    await page.goto("/cuenta");
    await expect(page.getByText(copy.failedOfflineTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(/Sin conexión desde hace/)).toBeVisible();
    await expect(page.getByText(/1 minuto/)).toHaveCount(0);
  });
});

// Module 653. The cap counts the UTC day, so the copy resumes at the next
// 00:00 UTC, drawn in the zone of the browser. Board `CuentaCopiaFallidaCuotaHora`:
// «Copiaste el máximo de hoy. Sigue sola a las 7:00 p. m.; tus palabras siguen en este dispositivo.»
// The clock is pinned to an October day so Madrid is UTC+2 whatever day this runs.
const OCT_9 = new Date("2026-10-09T15:00:00Z");

async function openCapped(page: Page, reader: Reader, signIn: () => Promise<void>): Promise<void> {
  await page.clock.install({ time: OCT_9 });
  await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: OCT_9.getTime() - 5 * 60_000 }) });
  await signIn();
  await page.route("**/api/log/sync", (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "quota" }) }),
  );
  await page.goto("/cuenta");
  await expect(page.getByText(copy.failedQuotaTitle, { exact: true })).toBeVisible();
}

const quotaLine = (page: Page) => page.getByText(/Copiaste el máximo de hoy\./);

async function expectCapRefusal(page: Page): Promise<void> {
  await expect(page.getByText(/Sin conexión/)).toHaveCount(0);
  await expect(page.getByText(copy.failedOfflineTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: copy.failedAction })).toHaveCount(0);
  await expect(page.getByText(/Mañana/)).toHaveCount(0);
  await expect(page.getByText(/\{|\}/)).toHaveCount(0);
}

test.describe("daily cap, Bogotá reader", () => {
  test.use({ timezoneId: "America/Bogota" });

  test("RL-22: the cap names the cause and the hour it resumes in the reader's zone: 7:00 p. m., never «Mañana»", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await withReader(page, async ({ reader, signIn }) => {
      await openCapped(page, reader, signIn);
      expect(await quotaLine(page).textContent()).toBe(
        "Copiaste el máximo de hoy. Sigue sola a las 7:00\u00a0p.\u00a0m.; tus palabras siguen en este dispositivo.",
      );
      await expectCapRefusal(page);
    });
  });
});

test.describe("daily cap, Bogotá reader, wide screen", () => {
  test.use({ timezoneId: "America/Bogota", viewport: { width: 1280, height: 800 } });

  test("RL-22: at 1280 the same line reads 7:00 p. m. and fits its column", async ({ page }) => {
    test.setTimeout(45_000);
    await withReader(page, async ({ reader, signIn }) => {
      await openCapped(page, reader, signIn);
      expect(await quotaLine(page).textContent()).toBe(
        "Copiaste el máximo de hoy. Sigue sola a las 7:00\u00a0p.\u00a0m.; tus palabras siguen en este dispositivo.",
      );
      const fits = await quotaLine(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(fits).toBe(true);
    });
  });
});

// Module 702: the hour is one piece. A Range over «7:00 p. m.» that wraps has
// two client rects; with non-breaking spaces it has one, whatever the width.
test.describe("daily cap, Bogotá reader, phone widths", () => {
  test.use({ timezoneId: "America/Bogota", viewport: { width: 390, height: 800 } });

  test("RL-22: at 390 and the widths around it, «7:00 p. m.» never breaks across lines", async ({ page }) => {
    test.setTimeout(60_000);
    await withReader(page, async ({ reader, signIn }) => {
      await openCapped(page, reader, signIn);
      const hourRects = () =>
        quotaLine(page).evaluate((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent ?? "";
            const start = text.indexOf("7:00");
            if (start < 0) continue;
            const end = text.indexOf("m.", start) + 2;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            return { rects: range.getClientRects().length, slice: text.slice(start, end) };
          }
          return null;
        });
      for (const width of [390, 340, 350, 360, 370, 380, 400, 410, 420]) {
        await page.setViewportSize({ width, height: 800 });
        const hour = await hourRects();
        expect(hour, `no hour in the line at ${width}px`).not.toBeNull();
        expect(hour!.slice).toBe("7:00\u00a0p.\u00a0m.");
        expect(hour!.rects, `the hour wraps at ${width}px`).toBe(1);
      }
    });
  });
});

test.describe("daily cap, Madrid reader", () => {
  test.use({ timezoneId: "Europe/Madrid" });

  test("RL-22: the same refusal reads 2:00 for a reader in Madrid (UTC+2 in October)", async ({ page }) => {
    test.setTimeout(45_000);
    await withReader(page, async ({ reader, signIn }) => {
      await openCapped(page, reader, signIn);
      const line = (await quotaLine(page).textContent()) ?? "";
      expect(line).toMatch(/^Copiaste el máximo de hoy\. Sigue sola a las 2:00(\u00a0a\.\u00a0m\.)?; tus palabras siguen en este dispositivo\.$/);
      expect(line).not.toContain("7:00");
      await expectCapRefusal(page);
    });
  });
});

test.describe("first copy not yet made", () => {
  test.use({ timezoneId: "America/Bogota" });

  test("RL-52: a confirmed reader with no copy yet reads «Aún no ha habido una copia.» and nothing about closing the tab", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await withReader(page, async ({ reader, signIn }) => {
      await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: null }) });
      await signIn();
      // The pull on open is held: the line is read while no round has finished.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/log/sync", async (route) => {
        await gate;
        await route.continue();
      });
      await page.goto("/cuenta");

      await expect(page.getByText("Aún no ha habido una copia.", { exact: true })).toBeVisible();
      await expect(page.getByText(/cierres esta pestaña/)).toHaveCount(0);
      await expect(page.getByText(/La primera sale/)).toHaveCount(0);
      await expect(page.getByText(/Última copia/)).toHaveCount(0);
      release();
      await expect(page.getByText(copy.lastCopyMoment, { exact: true })).toBeVisible();
      await expect(page.getByText("Aún no ha habido una copia.")).toHaveCount(0);
    });
  });
});

test.describe("the last-copy line keeps time", () => {
  test("RL-52, RNL-09: with the screen open, two minutes later it reads «hace 2 minutos» with no request and no reload", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await withReader(page, async ({ reader, signIn }) => {
      const t0 = Date.now();
      await page.clock.install({ time: t0 });
      await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: t0 - 10_000 }) });
      await signIn();
      // The pull on open is held for the whole test: only the clock moves the line.
      await page.route("**/api/log/sync", () => new Promise<never>(() => {}));
      const calls: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/")) calls.push(`${request.method()} ${request.url()}`);
      });
      // The device list asks once on open; the snapshot is taken after it.
      const devicesAsked = page.waitForRequest((request) => request.url().includes("/api/devices"));
      await page.goto("/cuenta");
      await devicesAsked;
      await expect(page.getByText(copy.lastCopyMoment, { exact: true })).toBeVisible();
      const before = [...calls];

      await page.clock.runFor(2 * 60_000);

      await expect(
        page.getByText(fillTemplate(copy.lastCopy, { time: "2 minutos" }), { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(copy.lastCopyMoment, { exact: true })).toHaveCount(0);
      expect(calls, "requests the minute clock made").toEqual(before);
    });
  });

  test("RL-52: leaving /cuenta clears the minute clock: the intervals standing are the ones the search screen had", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const live = new Set<number>();
      const set = window.setInterval.bind(window);
      const clear = window.clearInterval.bind(window);
      window.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const id = set(...args) as unknown as number;
        live.add(id);
        return id;
      }) as typeof setInterval;
      window.clearInterval = ((id?: number) => {
        if (id !== undefined) live.delete(id);
        return clear(id);
      }) as typeof clearInterval;
      (window as unknown as { __liveIntervals: () => number }).__liveIntervals = () => live.size;
    });
    await withReader(page, async ({ reader, signIn }) => {
      await seedLocal(page, { sync: confirmedFor(reader) });
      await signIn();
      await page.route("**/api/log/sync", () => new Promise<never>(() => {}));
      const live = () => page.evaluate(() => (window as unknown as { __liveIntervals: () => number }).__liveIntervals());

      await page.goto("/");
      await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
      const baseline = await live();

      const nav = page.getByRole("navigation", { name: messages.nav.label });
      await nav.getByRole("link", { name: messages.nav.account }).click();
      await expect(page.getByText(copy.lastCopy.replace("{time}", "5 minutos"), { exact: true })).toBeVisible();
      expect(await live(), "an interval stands while /cuenta is open").toBeGreaterThan(baseline);

      await nav.getByRole("link", { name: messages.nav.search }).click();
      await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
      await expect.poll(live).toBe(baseline);
    });
  });
});

test("RL-52, RL-24: retiring this very device shows the retired state, no copy button, and nothing leaves on hide", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    const posts = trackSync(page);
    await copyAndSeal(page, reader);

    // The retire confirmation names what happens to this device (approved words).
    await page.getByRole("button", { name: messages.account.devices.retire, exact: true }).click();
    await expect(page.getByText(OWN_BODY)).toBeVisible();
    await expect(page.getByText(LAST_DEVICE_BODY)).toBeVisible();
    await page.getByRole("button", { name: messages.account.devices.cancel }).click();

    await retireOwnDevice(page);

    await expect(page.getByText(RETIRED_TITLE)).toBeVisible();
    await expect(page.getByText(RETIRED_BODY)).toBeVisible();
    await expect(confirmButton(page)).toHaveCount(0);
    await expect(page.getByText(GONE_TITLE)).toHaveCount(0);

    const before = posts.length;
    await hideTab(page);
    await page.waitForTimeout(1500);
    expect(posts.length, "POSTs after hide on a retired device").toBe(before);

    const row = await readSync(page);
    expect(row?.retired, `sync row: ${JSON.stringify(row)}`).toBe(true);
    expect(row?.enabled).toBe(false);

    // It stays retired across a reload: no button to copy again.
    await page.reload();
    await expect(page.getByText(RETIRED_TITLE)).toBeVisible();
    await expect(confirmButton(page)).toHaveCount(0);
  });
});

test("RL-52, RL-24: a round the server answers 409 retired shows the retired state, not the failed one", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    await page.route("**/api/log/sync", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "retired" }) }),
    );
    await page.goto("/cuenta");
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await confirmCopy(page);

    await expect(page.getByText(RETIRED_TITLE)).toBeVisible();
    await expect(page.getByText(messages.account.copy.failedTitle)).toHaveCount(0);
    await expect(confirmButton(page)).toHaveCount(0);

    const row = await readSync(page);
    expect(row?.retired, `sync row: ${JSON.stringify(row)}`).toBe(true);
  });
});

test("RL-52, RL-24: after a retirement, signing out and in again offers the copy, and it starts under a new deviceId", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    const posts = trackSync(page);
    await copyAndSeal(page, reader);
    const retiredDevice = posts[0]!.deviceId;
    await retireOwnDevice(page);
    await expect(page.getByText(RETIRED_TITLE)).toBeVisible();

    await page.getByRole("button", { name: messages.account.signOut }).click();
    await expect(page).toHaveURL(/\/registro$/);

    await signIn();
    await page.goto("/cuenta");
    // The cure the retired state names: after signing out and in, the button is back.
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await expect(page.getByText(RETIRED_TITLE)).toHaveCount(0);

    const count = posts.length;
    await confirmCopy(page);
    await expectDone(page);
    expect(posts.length).toBe(count + 1);
    expect(posts[count]!.deviceId).not.toBe(retiredDevice);
    expect(posts[count]!.since).toBeNull();
  });
});

test("RL-52: another reader on this device confirms under a new deviceId and uploads nothing searched before", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    const readerA = randomUUID();
    const deviceOfA = randomUUID();
    await seedLocal(page, {
      sync: {
        deviceId: deviceOfA,
        pushedThroughLocalId: 2,
        pulledThroughCursor: "cursor-of-reader-a",
        lastSyncedAt: Date.now() - 60_000,
        enabled: true,
        readerId: readerA,
        retired: false,
      },
      lookups: [localRow("one"), localRow("two")],
    });
    await signIn();
    const posts = trackSync(page);
    await page.goto("/cuenta");

    // A copy running for A is not B's: B is asked.
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await expect(confirmButton(page)).toBeVisible();
    await expect(page.getByText(copy.otherReader, { exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(posts, "POSTs before B confirmed").toHaveLength(0);

    await confirmCopy(page);
    await expectDone(page);

    const first = posts[0]!;
    expect(first.deviceId).not.toBe(deviceOfA);
    expect(first.since).toBeNull();
    // A's two rows stay on the device: B's copy starts past them.
    expect(first.rows, `first POST: ${JSON.stringify(first)}`).toHaveLength(0);

    const row = await readSync(page);
    expect(row?.readerId).toBe(reader.id);
    expect(row?.deviceId).toBe(first.deviceId);
    expect(row?.pushedThroughLocalId).toBe(2);

    // B searches `apple`: the next round carries that one row and neither of A's.
    const asset = page.waitForResponse((r) => r.url().includes(manifest.asset.path) && r.ok());
    await page.goto("/");
    await asset;
    await page.getByRole("textbox", { name: messages.search.label }).fill("apple");
    // The row is buffered when the answer lands; hiding before that flushes nothing.
    await expect(page.getByRole("heading", { name: "apple", exact: true })).toBeVisible();
    const next = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
    await hideTab(page);
    await next;
    await expect.poll(() => countLookups(page), { message: "apple recorded" }).toBe(3);
    await page.waitForTimeout(500);
    const second = posts[1]!;
    expect(second.deviceId).toBe(first.deviceId);
    expect(
      second.rows.map((r) => (r as { text: string }).text),
      `second POST: ${JSON.stringify(second)}`,
    ).toEqual(["apple"]);
  });
});

test("RL-52: the same reader coming back confirms and keeps their deviceId and cursors", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    const device = randomUUID();
    await seedLocal(page, {
      sync: {
        deviceId: device,
        pushedThroughLocalId: 2,
        pulledThroughCursor: null,
        lastSyncedAt: Date.now() - 60_000,
        enabled: false,
        readerId: reader.id,
        retired: false,
      },
      lookups: [localRow("one"), localRow("two")],
    });
    await signIn();
    const posts = trackSync(page);
    await page.goto("/cuenta");

    await expect(confirmButton(page)).toBeVisible();
    await expect(page.getByText(copy.otherReader, { exact: true })).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(posts, "POSTs before confirming").toHaveLength(0);

    await confirmCopy(page);
    await expectDone(page);

    expect(posts[0]!.deviceId).toBe(device);
    // The two rows were already pushed: the cursor survived.
    expect(posts[0]!.rows, `first POST: ${JSON.stringify(posts[0])}`).toHaveLength(0);
  });
});

test("RL-25, RNL-02: the device list names a device in Spanish, and an unreadable or old English label as unknown", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ sql, reader, signIn }) => {
    await sql`insert into reading.devices (user_id, device_id, label, last_seen_at) values
      (${reader.id}, ${randomUUID()}, 'chrome:android', now()),
      (${reader.id}, ${randomUUID()}, 'safari:ios', now() - interval '1 minute'),
      (${reader.id}, ${randomUUID()}, 'unknown:unknown', now() - interval '2 minutes'),
      (${reader.id}, ${randomUUID()}, 'Chrome on Android', now() - interval '3 minutes')`;
    await signIn();
    await page.goto("/cuenta");

    await expect(page.getByText("Chrome en Android", { exact: true })).toBeVisible();
    await expect(page.getByText("Safari en iPhone", { exact: true })).toBeVisible();
    await expect(page.getByText(UNKNOWN_DEVICE, { exact: true })).toHaveCount(2);

    for (const raw of ["chrome:android", "safari:ios", "unknown:unknown", "Chrome on Android"]) {
      await expect(page.getByText(raw, { exact: true }), `raw label «${raw}» on screen`).toHaveCount(0);
    }
    await expect(page.getByText(/\b(Chrome|Safari|Firefox|Edge|Opera) on \b/)).toHaveCount(0);
  });
});

test("RL-25: with no device copying, the list says so, and keeps saying so", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    await page.goto("/cuenta");
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();

    await expect(page.getByText(messages.account.devices.empty)).toBeVisible();
    // Nothing was confirmed, so nothing seals a device behind the empty list.
    await page.waitForTimeout(2000);
    await expect(page.getByText(messages.account.devices.empty)).toBeVisible();
  });
});

test("RNL-09: with no session, /cuenta offers the account and sends nothing, on load or on hide", async ({ page }) => {
  const posts = trackSync(page);
  await page.goto("/cuenta");

  await expect(page.getByText(messages.account.copy.noSessionTitle)).toBeVisible();
  await expect(page.getByText(messages.account.copy.noSessionAction)).toBeVisible();
  await expect(confirmButton(page)).toHaveCount(0);

  await page.waitForTimeout(1500);
  await hideTab(page);
  await page.waitForTimeout(1500);
  expect(posts, `POSTs with no session: ${JSON.stringify(posts)}`).toHaveLength(0);
});

test("RL-52: the first reader on this device uploads every row they have searched", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { lookups: [localRow("alpha"), localRow("beta"), localRow("gamma")] });
    await signIn();
    const posts = trackSync(page);
    await page.goto("/cuenta");
    await expect(page.getByText(confirmTitle(reader.email))).toBeVisible();
    await confirmCopy(page);
    await expectDone(page);

    expect(posts).toHaveLength(1);
    expect(
      posts[0]!.rows.map((r) => (r as { text: string }).text).sort(),
      `first POST: ${JSON.stringify(posts[0])}`,
    ).toEqual(["alpha", "beta", "gamma"]);
  });
});

test("RL-52: the count while copying is what is left to send, not every row on the device", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    const foreignDevice = randomUUID();
    await seedLocal(page, {
      sync: confirmedFor(reader, { enabled: false, lastSyncedAt: null }),
      lookups: [
        localRow("mine-1"),
        localRow("mine-2"),
        localRow("mine-3"),
        localRow("theirs-1", { device: foreignDevice, deviceSeq: 1 }),
        localRow("theirs-2", { device: foreignDevice, deviceSeq: 2 }),
      ],
    });
    await signIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/log/sync", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/cuenta");
    await expect(confirmButton(page)).toBeVisible();
    await confirmCopy(page);

    await expect(page.getByText(searchesLine(3), { exact: true })).toBeVisible();
    await expect(page.getByText(searchesLine(5), { exact: true })).toHaveCount(0);
    release();
    await expectDone(page);
  });
});

test("RL-52: with nothing to send, the copy only brings and says so in the zero form", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { sync: confirmedFor(reader, { enabled: false, lastSyncedAt: null }) });
    await signIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/log/sync", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/cuenta");
    await expect(confirmButton(page)).toBeVisible();
    await confirmCopy(page);

    await expect(page.getByText(searchesLine(0), { exact: true })).toBeVisible();
    release();
    await expectDone(page);
  });
});

test("RL-52, RNL-02: opening /cuenta with the copy on keeps the last-copy line while it pulls, then updates it", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: Date.now() - 3 * 60_000 }) });
    await signIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/log/sync", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/cuenta");

    await expect(page.getByText(fillTemplate(copy.lastCopy, { time: "3 minutos" }), { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByText(/Copiando/)).toHaveCount(0);
    release();
    await expect(page.getByText(copy.lastCopyMoment, { exact: true })).toBeVisible();
    await expect(page.getByText(/Copiando/)).toHaveCount(0);
  });
});

test("RL-52, RNL-09: opening /cuenta with the copy on pulls once, then the device list is asked again", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    const seededAt = Date.now() - 5 * 60_000;
    await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: seededAt }) });
    await signIn();
    const posts = trackSync(page);
    const deviceLists: number[] = [];
    const postLandedAt: number[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/devices") && r.method() === "GET") deviceLists.push(Date.now());
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/log/sync")) postLandedAt.push(Date.now());
    });

    await page.goto("/cuenta");
    await expectDone(page);
    await expect.poll(() => deviceLists.length, { message: "device list asked again" }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1500);

    expect(posts, `POSTs on open: ${JSON.stringify(posts)}`).toHaveLength(1);
    expect(posts[0]!.deviceId).toBe((await readSync(page))!.deviceId);
    expect(deviceLists.at(-1)!, "the last list request follows the pull").toBeGreaterThanOrEqual(postLandedAt[0]!);
    const row = await readSync(page);
    expect(row!.lastSyncedAt!, "the pull stamped the copy").toBeGreaterThan(seededAt + 4 * 60_000);
  });
});

test("RL-52: a retired device that still has the copy flag opens /cuenta without a single request", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await seedLocal(page, { sync: confirmedFor(reader, { retired: true }) });
    await signIn();
    const posts = trackSync(page);
    await page.goto("/cuenta");
    await expect(page.getByText(RETIRED_TITLE)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(posts, `POSTs on a retired device: ${JSON.stringify(posts)}`).toHaveLength(0);
  });
});

test("RNL-09: a copy left on with no session is turned off on /cuenta, and a hidden tab sends nothing", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await seedLocal(page, {
    sync: {
      deviceId: randomUUID(),
      pushedThroughLocalId: null,
      pulledThroughCursor: null,
      lastSyncedAt: null,
      enabled: true,
      readerId: randomUUID(),
      retired: false,
    },
    lookups: [localRow("left-behind")],
  });
  const posts = trackSync(page);
  await page.goto("/cuenta");
  await expect(page.getByText(copy.noSessionTitle)).toBeVisible();
  await expect.poll(async () => (await readSync(page))?.enabled, { message: "enabled in IndexedDB" }).toBe(false);

  await hideTab(page);
  await page.waitForTimeout(1500);
  expect(posts, `POSTs after hide with no session: ${JSON.stringify(posts)}`).toHaveLength(0);
});

// The board's field width: the email field and its button share 400 px at 1280.
const BOARD_FIELD_MAX = 400;

test.describe("signed out, wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("RNL-03: the email field and its button stop at the board's 400 px", async ({ page }) => {
    await page.goto("/cuenta");
    const field = page.getByRole("textbox", { name: messages.account.emailLabel });
    await expect(field).toBeVisible();
    const fieldBox = (await field.boundingBox())!;
    const buttonBox = (await page.getByRole("button", { name: copy.noSessionAction }).boundingBox())!;
    expect(fieldBox.width, `field ${fieldBox.width}px`).toBeLessThanOrEqual(BOARD_FIELD_MAX + 1);
    expect(fieldBox.width, `field ${fieldBox.width}px`).toBeGreaterThan(200);
    expect(buttonBox.width, `button ${buttonBox.width}px`).toBeLessThanOrEqual(BOARD_FIELD_MAX + 1);
  });
});

test.describe("signed out, phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("RNL-03: at 360 the email field is the width of the column", async ({ page }) => {
    await page.goto("/cuenta");
    const field = page.getByRole("textbox", { name: messages.account.emailLabel });
    await expect(field).toBeVisible();
    const column = (await page.getByText(copy.noSessionBody).boundingBox())!;
    // The input sits inside its bordered root; the root is what spans the column.
    const fieldBox = (await field.locator("xpath=..").boundingBox())!;
    expect(Math.abs(fieldBox.width - column.width), `field ${fieldBox.width}px, column ${column.width}px`).toBeLessThanOrEqual(1);
  });
});

// Module 702 (RNL-09): the reload the returning network causes is the open of
// `/cuenta` that the cut interrupted, so it runs that open's pull once, no more.
test.describe("network returns on /cuenta", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("RNL-09: signed in, offline then back: the page reloads and runs a single pull", async ({ page, context }) => {
    test.setTimeout(60_000);
    await deleteTranslator(page);
    await withReader(page, async ({ reader, signIn }) => {
      await seedLocal(page, { sync: confirmedFor(reader, { lastSyncedAt: Date.now() - 3 * 3_600_000 }) });
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            for (const name of await caches.keys()) {
              if (await (await caches.open(name)).match(new URL("/cuenta", location.origin).toString())) return true;
            }
            return false;
          }),
        )
        .toBe(true);
      await signIn();

      await context.setOffline(true);
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      });
      await page.goto("/cuenta");
      await expect(page.getByText(/Sin conexión desde hace/)).toBeVisible();

      const posts = trackSync(page);
      await page.evaluate(() => sessionStorage.setItem("net-back", "1"));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          get: () => sessionStorage.getItem("net-back") !== null,
        });
      });
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));

      await expect(page.getByText(/Sin conexión/)).toHaveCount(0);
      await expect(page.getByText(copy.lastCopyMoment, { exact: true })).toBeVisible();
      expect(posts).toHaveLength(1);
    });
  });
});
