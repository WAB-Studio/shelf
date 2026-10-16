import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { test as base, expect, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";

// The signed-in person every spec drives: the suite's global setup mints a
// real identity under its own run and writes its cookie to this file —
// never a typed address, never a fresh sign-in per spec (RNP-09).
// `playwright.config.ts` points the whole suite's browser context at it;
// nothing here opens `/entrar`.
export function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

export function sessionFile(): string {
  return resolve(process.cwd(), `private/session-${laneNumber()}.json`);
}

type StoredCookie = { name: string; value: string };
type StorageState = { cookies: StoredCookie[]; origins: unknown[] };

function loadStorageState(file = sessionFile()): StorageState {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no session at ${file} — scripts/harness/e2e-run.ts mints it before any spec`);
  }
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

// `@supabase/ssr` chunks a cookie past its own length cap and, by default,
// prefixes the whole payload with `base64-` (`cookies.js`'s own
// `decodeChunkedCookieValue`). Nothing here re-implements that module —
// this only ever reads a cookie `mint-session.ts` itself just wrote, so the
// two encodings this file actually meets are covered and nothing else.
function accessTokenFromCookies(cookies: StoredCookie[]): string {
  const chunks = cookies
    .filter((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("auth-token"))
    .sort((a, b) => {
      const na = Number(a.name.split(".").pop());
      const nb = Number(b.name.split(".").pop());
      return (Number.isNaN(na) ? 0 : na) - (Number.isNaN(nb) ? 0 : nb);
    });
  if (chunks.length === 0) throw new Error("storage state carries no sb-*-auth-token cookie");

  const raw = chunks.map((cookie) => cookie.value).join("");
  const encoded = raw.startsWith("base64-") ? raw.slice("base64-".length) : raw;
  const session = JSON.parse(decodeBase64Url(encoded)) as { access_token: string };
  return session.access_token;
}

// Read straight off the access token's own payload, unverified — this file
// only ever decodes a token `mint-session.ts` minted for itself, never one
// carried in from outside.
function claimsFromAccessToken(token: string): { id: string; email: string } {
  const [, payload] = token.split(".");
  const claims = JSON.parse(decodeBase64Url(payload)) as { sub: string; email: string };
  return { id: claims.sub, email: claims.email };
}

export function seededPerson(): { id: string; email: string } {
  const { cookies } = loadStorageState();
  return claimsFromAccessToken(accessTokenFromCookies(cookies));
}

// A person of a spec's own, under a session file no other test can name: the
// path is a fresh UUID, never a number two files could pick alike. Two
// workers minting one path overwrote each other's cookie, and the teardown of
// one dropped the rows the other was measuring. Registered under the suite's
// run (`HARNESS_RUN_ID`), whose teardown drops the identity.
export function mintDisposablePerson(baseUrl: string): { id: string; sessionFile: string } {
  const file = `private/disposable/${randomUUID()}.json`;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--env-file=.env.local", "scripts/harness/mint-session.ts"],
    { env: { ...process.env, MINT_SESSION_FILE: file, PULSAR_BASE_URL: baseUrl }, stdio: "pipe" },
  );
  const absolute = resolve(process.cwd(), file);
  const { cookies } = loadStorageState(absolute);
  return { id: claimsFromAccessToken(accessTokenFromCookies(cookies)).id, sessionFile: absolute };
}

export type Person = { id: string; sessionFile: string };

type Fixtures = {
  // One connection per test, bypassing RLS the same way `MIGRATION_DATABASE_URL`
  // does for every harness script — never the app's own `DATABASE_URL` role
  // rules out reaching, and never a policy this suite has any business
  // proving from outside the app (`check-policies.ts` owns that).
  db: postgres.Sql;
  personId: string;
  // The worker's own person with no rows: what a spec seeds is all there is.
  person: Person;
};

type WorkerFixtures = {
  workerPerson: Person;
};

// Every table a pulsar person owns, children first. `goals.goals` cascades to
// commitments, phases and the facts and one-offs under them, but a dayless
// one-off and a fact with no goal hang off the person alone. Sources are the
// app's catalogue, not a person's rows.
async function clearPerson(sql: postgres.Sql, id: string): Promise<void> {
  await sql`delete from goals.access_tokens where user_id = ${id}`;
  await sql`delete from goals.model_calls where user_id = ${id}`;
  await sql`delete from goals.facts where user_id = ${id}`;
  await sql`delete from goals.one_offs where user_id = ${id}`;
  await sql`delete from goals.commitments where user_id = ${id}`;
  await sql`delete from goals.phases where user_id = ${id}`;
  await sql`delete from goals.goals where user_id = ${id}`;
}

// Named `provide`, not Playwright's own `use`: an identically-named
// parameter here reads to `eslint-plugin-react-hooks` as the `use` hook,
// which this file, being test wiring rather than a component, is not
// (`apps/voyager/e2e/fixtures.ts`'s own fix for the same warning).
export const test = base.extend<Fixtures, WorkerFixtures>({
  db: async ({}, provide) => {
    const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
    await provide(sql);
    await sql.end();
  },

  personId: async ({}, provide) => {
    await provide(seededPerson().id);
  },

  // One magic-link verification per worker, not per test: Auth's token
  // verification rate limit counts every mint of every lane and CI at once
  // (docs/TRAPS.md, `linkInvalid`). Registered under the suite's run, whose
  // teardown drops the identity.
  workerPerson: [
    async ({}, provide, workerInfo) => {
      await provide(mintDisposablePerson(workerInfo.project.use.baseURL ?? "http://localhost:3200"));
    },
    { scope: "worker" },
  ],

  // Isolation by rows, not by person: cleared before the test, so a spec that
  // died mid-seed leaves nothing for the next one.
  person: async ({ workerPerson, db }, provide) => {
    await clearPerson(db, workerPerson.id);
    await provide(workerPerson);
  },
});

// Next's route announcer is an open shadow root holding `role="alert"`, which
// `getByRole` pierces; the app's alerts are every body child but that one.
export function appAlerts(page: Page): Locator {
  return page.locator("body > :not(next-route-announcer)").locator('xpath=descendant-or-self::*[@role="alert"]');
}

// `load` fires with the loading fallback still standing, and the real page sits
// in a hidden streamed div with no box: anchor on one visible `main` and the
// fonts before any box or style is read (docs/TRAPS.md).
export async function settled(page: Page): Promise<void> {
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

export async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await settled(page);
}

export { expect };
