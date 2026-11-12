import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Page, Route } from "@playwright/test";
import postgres from "postgres";

import { closeRun, openRun } from "@repo/harness-registry";

import messages from "../messages/es.json";
import type { LogExport } from "../lib/log/export";
import { DATABASE_VERSION } from "../lib/log/record";
import { LOOKUP_SCHEMA, type LookupRecord, type SyncState } from "../lib/log/types";
import { confirmCopy, expect, test } from "./fixtures";

// RL-93, RL-94, RL-95: the review travels with the account. The device's half is driven with the route's answers
// written here; the whole loop, once, against a real reader and two browser contexts. Never types an address into
// /cuenta: the session enters through the harness, as `cuenta-copia.spec.ts` does.

try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

type Reader = { id: string; email: string };
type Wire = { key: string; at: number; gone: boolean; card: Record<string, unknown> | null; sense: unknown };
type ReviewPost = { readerId: string; entries: Wire[]; since: string | null };
type SeedLookup = Omit<LookupRecord, "id">;

const NOTHING_DUE = "Hoy no tienes palabras por repasar.";

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

function wordRow(text: string): SeedLookup {
  return {
    schema: LOOKUP_SCHEMA,
    at: Date.now(),
    text,
    normalised: text,
    kind: "word",
    outcome: "exact",
    headword: text,
    rule: null,
    senses: 1,
    translation: "cachear",
    dictionaryReady: true,
    origin: null,
  };
}

function copyOn(): SyncState {
  return {
    deviceId: randomUUID(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId: randomUUID(),
    retired: false,
  };
}

// Seeded from `/`: `/registro` fires a round on open that would race this write.
async function seed(page: Page, rows: { sync?: SyncState; lookups: SeedLookup[] }): Promise<void> {
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
            request.transaction!.objectStore("lookups").createIndex("foreign", ["device", "deviceSeq"], { unique: true });
          }
          if (event.oldVersion < 3) {
            request.transaction!.objectStore("lookups").createIndex("headword", "headword");
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["lookups", "sync"], "readwrite");
          if (sync) tx.objectStore("sync").put({ ...sync, key: "state" });
          for (const row of lookups) tx.objectStore("lookups").add(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { version: DATABASE_VERSION, sync: rows.sync ?? null, lookups: rows.lookups },
  );
}

// The keys the review's own database holds in one store, read by name as no import reaches into a page's IndexedDB.
// The connection is closed at once: an open one would block the app's own upgrade.
async function reviewKeys(page: Page, store: "cards" | "senses" | "gone"): Promise<string[]> {
  return page.evaluate(
    (name) =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("reading-review");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(name)) {
            db.close();
            resolve([]);
            return;
          }
          const keys = db.transaction(name, "readonly").objectStore(name).getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve(keys.result as string[]);
          };
          keys.onerror = () => reject(keys.error);
        };
      }),
    store,
  );
}

function answerJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

const emptyLogRound = { accepted: 0, rows: [], cursor: null };

async function reviewFrisk(page: Page, grade: "good" | "easy" = "easy"): Promise<void> {
  await page.goto("/repaso");
  await expect(page.getByRole("heading", { name: "frisk" })).toBeVisible();
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade[grade]}`) }).click();
  await expect(page.getByText(NOTHING_DUE).or(page.getByText(/Terminaste por hoy/))).toBeVisible();
}

function learntCard(at: number) {
  return {
    due: at + 4 * 86_400_000,
    stability: 4.1,
    difficulty: 5.3,
    scheduledDays: 4,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    lastReview: at,
    introducedOn: "2026-11-01",
  };
}

test("RL-93: a card the account holds makes the word one already learning here, not new", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [wordRow("snuff"), wordRow("frisk")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, emptyLogRound));
  const at = Date.now() - 4 * 86_400_000;
  await page.route("**/api/review/sync", (route) =>
    answerJson(route, {
      accepted: 0,
      entries: [{ key: "frisk", at, gone: false, card: { ...learntCard(at), due: Date.now() - 1_000 }, sense: null }],
      cursor: "account-1",
    }),
  );

  await page.goto("/registro");
  await expect.poll(() => reviewKeys(page, "cards")).toEqual(["frisk"]);

  await page.goto("/repaso");
  await expect(page.getByText("1 de 2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "frisk" })).toBeVisible();
  await expect(page.getByText(messages.review.newWord)).toHaveCount(0);
});

test("RL-93: a review here goes up with the copy on, and a later deletion in the account takes the card out", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [wordRow("frisk")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, emptyLogRound));
  const posts: ReviewPost[] = [];
  let deletion: Wire | null = null;
  await page.route("**/api/review/sync", (route) => {
    posts.push(route.request().postDataJSON() as ReviewPost);
    return answerJson(route, { accepted: 0, entries: deletion ? [deletion] : [], cursor: deletion ? "account-2" : null });
  });

  await reviewFrisk(page);
  await page.goto("/registro");
  await expect.poll(() => posts.flatMap((post) => post.entries).some((sent) => sent.key === "frisk")).toBe(true);
  const sent = posts.flatMap((post) => post.entries).find((entry) => entry.key === "frisk")!;
  expect(sent.gone).toBe(false);
  expect(sent.card).toMatchObject({ reps: 1 });
  expect(await reviewKeys(page, "cards")).toEqual(["frisk"]);

  deletion = { key: "frisk", at: Date.now() + 60_000, gone: true, card: null, sense: null };
  await page.goto("/registro");
  await expect.poll(() => reviewKeys(page, "cards")).toEqual([]);
});

test("RL-93: with no account the review works as before and asks the network for nothing", async ({ page }) => {
  await deleteTranslator(page);
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/review/")) asked.push(request.url());
  });
  await seed(page, { lookups: [wordRow("frisk")] });

  await reviewFrisk(page);
  await page.goto("/registro");
  await expect(page.locator('a[href="/registro/frisk"]')).toBeVisible();
  expect(await reviewKeys(page, "cards")).toEqual(["frisk"]);
  expect(asked).toEqual([]);
});

test("RL-95: the export carries the review's cards and senses, under exportSchema 2", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { lookups: [wordRow("frisk")] });
  await reviewFrisk(page);
  await page.goto("/registro");

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: messages.log.study.download }).click();
  const download = await downloading;
  const file = await download.path();
  if (!file) throw new Error("no download path");
  const exported = JSON.parse(await fs.readFile(file, "utf-8")) as LogExport;

  expect(exported.exportSchema).toBe(2);
  expect(exported.rows).toHaveLength(1);
  expect(exported.review.cards.map((card) => card.key)).toEqual(["frisk"]);
  expect(exported.review.cards[0]).toMatchObject({ reps: 1, introducedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(exported.review.senses).toEqual([]);
});

test("RL-94: with no account, /cuenta and the confirmation before «Vaciar» say the review lives on this device alone", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { lookups: [wordRow("frisk")] });

  await page.goto("/cuenta");
  await expect(page.getByText(messages.account.copy.noSessionReview)).toBeVisible();

  await page.goto("/registro");
  await page.getByRole("button", { name: messages.log.clear.trigger }).click();
  await expect(page.getByText(messages.log.clear.reviewLocal)).toBeVisible();
  await expect(page.getByText(messages.log.clear.reviewAccount)).toHaveCount(0);
});

function landToken(sql: postgres.Sql, reader: Reader): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  return sql
    .begin(async (tx) => {
      await tx`
        update auth.users
        set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
        where id = ${reader.id}`;
      await tx`
        insert into auth.one_time_tokens
          (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
        values
          (${randomUUID()}, ${reader.id}, 'recovery_token', ${hash}, ${reader.email}, now(), now())`;
    })
    .then(() => hash);
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
  const response = await page.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, { maxRedirects: 0 });
  const location = response.headers()["location"];
  expect(location?.includes("error="), `redirected to ${location ?? "nowhere"}`).toBe(false);
}

test("RL-93, RL-94: a card reviewed on one device is in the account and comes down on the reader's other device", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  const reader = await mintReader(sql, runId);
  const other = await browser.newContext({ baseURL });
  try {
    await deleteTranslator(page);
    await seed(page, { lookups: [wordRow("frisk")] });
    await signInWith(page, await landToken(sql, reader));

    // Before the copy is confirmed the screen says the review will travel; after, that it does.
    await page.goto("/cuenta");
    await expect(page.getByText(messages.account.copy.reviewConfirm)).toBeVisible();
    await confirmCopy(page);
    await expect(page.getByText(messages.account.copy.reviewTravels)).toBeVisible();

    await reviewFrisk(page);
    await page.goto("/registro");
    await expect
      .poll(async () => (await sql`select key from reading.review_entries where user_id = ${reader.id}`).map((row) => row.key))
      .toEqual(["frisk"]);

    // The confirmation before «Vaciar» names the account as well.
    await page.getByRole("button", { name: messages.log.clear.trigger }).click();
    await expect(page.getByText(messages.log.clear.reviewAccount)).toBeVisible();

    // The reader's other device: a browser with nothing, signed in as the same reader.
    const second = await other.newPage();
    await deleteTranslator(second);
    await signInWith(second, await landToken(sql, reader));
    await second.goto("/cuenta");
    await confirmCopy(second);
    await expect.poll(() => reviewKeys(second, "cards")).toEqual(["frisk"]);

    // The word came down already put away: nothing is due, and it is not asked as new.
    await second.goto("/repaso");
    await expect(second.getByText(NOTHING_DUE)).toBeVisible();
    await expect(second.getByText(messages.review.newWord)).toHaveCount(0);
  } finally {
    await other.close();
    for (let attempt = 0; ; attempt++) {
      try {
        await sql`delete from harness.identities where user_id = ${reader.id}`;
        await sql`delete from auth.users where id = ${reader.id}`;
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "40P01" || attempt >= 4) throw error;
      }
    }
    await closeRun(sql);
    await sql.end();
  }
});
