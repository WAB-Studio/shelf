/**
 * Layer 2 of the harness: every route over HTTP, against the running dev server,
 * under an authentic Supabase session. Layer 1 drives the query functions in
 * process; this drives the proxy, the layouts, the metadata and the route
 * handlers as a browser would, and asserts on what the wire actually carries.
 *
 * Redirects are FOLLOWED in the render suite, so a route that lands elsewhere is
 * reported by the path it landed on rather than hidden behind a 3xx. The guard
 * suite follows nothing: the redirect itself is what it asserts.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { openRun } from "@repo/harness-registry";
import ExcelJS from "exceljs";

import messages from "@/messages/es.json";

import { assert, report, skip } from "./harness/assert";
import {
  asOwner,
  cleanup,
  countOwnedMovements,
  fixtureSql,
  purgeAuditTrail,
  track,
  YEAR_OF_MOVEMENTS,
} from "./harness/fixtures";
import {
  HARNESS_BASE_URL,
  HARNESS_EMAIL,
  cookieHeader,
  harnessSession,
  mintedThisRun,
  sessionFileName,
} from "./harness/session";

const LOCALE = "es";
// The debt the detail route is driven against. Its name is the title that page
// carries, so the render case asserts on this very string.
const DEBT_NAME = "Harness HTTP tarjeta";
// A movement no one owns, so the detail page refuses it.
const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";
const APP_GROUP_DIR = resolve(process.cwd(), "app/[locale]/(app)");

let counter = 0;

function next(name: string): string {
  counter += 1;
  return `H${counter}. ${name}`;
}

// The document title a page is expected to carry, read from the same message
// file the page reads. Hardcoding the Spanish here would rot on the first edit.
function title(key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown>)[part],
      messages,
    );
  if (typeof value !== "string") throw new Error(`no message at ${key}`);

  return value;
}

function documentTitle(body: string): string {
  return /<title[^>]*>([^<]*)<\/title>/.exec(body)?.[1] ?? "(no title)";
}

// Next marks every refusal `<html id="__next_error__">`, the app's own not-found
// screen included. A 200 carrying it is a page that threw; a 404 that lacks it
// never reached the refusal it claims.
function isErrorShell(body: string): boolean {
  return body.includes("__next_error__");
}

// What Next injects in place of the status it can no longer set, once a refusal
// arrives mid-stream. It is the only thing a soft 404 and a rendered screen do
// not share, so it is what tells the two apart on the wire.
function isNoindex(body: string): boolean {
  return body.includes('name="robots" content="noindex"');
}

type Rendered = {
  status: number;
  landedOn: string;
  title: string;
  errorShell: boolean;
  noindex: boolean;
};

async function get(path: string, cookie?: string): Promise<Rendered> {
  const response = await fetch(`${HARNESS_BASE_URL}${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
  const body = await response.text();

  return {
    status: response.status,
    landedOn: new URL(response.url).pathname,
    title: documentTitle(body),
    errorShell: isErrorShell(body),
    noindex: isNoindex(body),
  };
}

type AppRoute = { path: string; page: boolean };

/**
 * Every route file under `app/[locale]/(app)/`, as a path. Walked rather than
 * listed, so a route added tomorrow is guarded by this run without an edit here.
 * A dynamic segment takes the fixture's id.
 */
function appGroupRoutes(transactionId: string): AppRoute[] {
  const paths: AppRoute[] = [];

  function walk(directory: string, segments: string[]): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // A route group is a folder, never a URL segment.
        const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
        const segment = entry.name.startsWith("[")
          ? transactionId
          : entry.name;

        walk(join(directory, entry.name), isGroup ? segments : [...segments, segment]);
      } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
        paths.push({
          path: `/${LOCALE}${segments.map((one) => `/${one}`).join("")}`,
          page: entry.name === "page.tsx",
        });
      }
    }
  }

  walk(APP_GROUP_DIR, []);

  return paths.sort((a, b) => a.path.localeCompare(b.path));
}

type RenderCase = {
  path: string;
  status: number;
  title: string;
  // Where the follow ended, when the route answers a redirect of its own.
  landsOn?: string;
  // Named only where the body has to prove a refusal the status cannot.
  noindex?: boolean;
  why?: string;
};

function renderCases({ transactionId, debtAccountId }: HttpScope): RenderCase[] {
  return [
    { path: `/${LOCALE}`, status: 200, title: title("common.appName") },
    { path: `/${LOCALE}/inbox`, status: 200, title: title("ingest.title") },
    {
      path: `/${LOCALE}/movements`,
      status: 200,
      title: title("transactions.listTitle"),
    },
    {
      path: `/${LOCALE}/movements/${transactionId}`,
      status: 200,
      title: title("transactions.detailTitle"),
    },
    { path: `/${LOCALE}/reports`, status: 200, title: title("reports.title") },
    { path: `/${LOCALE}/planning`, status: 200, title: title("planning.title") },
    {
      path: `/${LOCALE}/planning/budgets`,
      status: 200,
      title: title("budgets.title"),
    },
    {
      path: `/${LOCALE}/planning/debts`,
      status: 200,
      title: title("debts.title"),
    },
    // The debt the fixture opened, with its terms, its dated cuotas and the
    // movement that settled the first of them: the detail names it in the title.
    {
      path: `/${LOCALE}/planning/debts/${debtAccountId}`,
      status: 200,
      title: DEBT_NAME,
    },
    // The path the coverage walk builds for this route, since it substitutes the
    // fixture's transaction id into every dynamic segment. A movement's id names
    // no account, so `getDebtDetail` returns null and the page calls
    // `notFound()` — after the `loading.tsx` above it flushed, so it arrives as
    // noindex in the body over a 200 on the wire, exactly as `/movements/[id]`
    // does for an id it cannot find.
    {
      path: `/${LOCALE}/planning/debts/${transactionId}`,
      status: 200,
      title: title("debts.title"),
      noindex: true,
      why: "a transaction id names no debt: a streamed notFound()",
    },
    {
      path: `/${LOCALE}/planning/goals`,
      status: 200,
      title: title("goals.title"),
    },
    {
      path: `/${LOCALE}/planning/payments`,
      status: 200,
      title: title("plannedPayments.title"),
    },
    {
      path: `/${LOCALE}/planning/recurring`,
      status: 200,
      title: title("recurringRules.title"),
    },
    { path: `/${LOCALE}/settings`, status: 200, title: title("nav.settings") },
    {
      path: `/${LOCALE}/settings/accounts`,
      status: 200,
      title: title("accounts.title"),
    },
    {
      path: `/${LOCALE}/settings/categories`,
      status: 200,
      title: title("categories.title"),
    },
    {
      path: `/${LOCALE}/settings/labels`,
      status: 200,
      title: title("labels.title"),
    },
    {
      path: `/${LOCALE}/settings/audit`,
      status: 200,
      title: title("audit.title"),
    },
    {
      path: `/${LOCALE}/settings/data`,
      status: 200,
      title: title("data.screen.title"),
    },
    {
      path: `/${LOCALE}/settings/webhooks`,
      status: 200,
      title: title("webhooks.title"),
    },
    // 404 by design: the harness user leads no group (RF-55). The refusal is the
    // shell layout's, not the page's — a `loading.tsx` fallback commits the
    // response to 200 before any page under `(app)` runs, and the layout of that
    // same segment is the last thing the boundary does not wrap. Asserting 200
    // would make this transcript lie about the screen.
    {
      path: `/${LOCALE}/settings/members`,
      status: 404,
      title: title("metadata.title"),
      why: "RF-55: no group, so the shell layout refuses the route",
    },
    {
      path: `/${LOCALE}/settings/group`,
      status: 404,
      title: title("metadata.title"),
      why: "RF-55: no group, so the shell layout refuses the route",
    },
    // The same refusal one segment too low, and what it costs. `page.tsx` calls
    // `notFound()` for a movement it did not find, but by then the fallback has
    // flushed: "When a `<Suspense>` fallback renders ... the server must commit to
    // `200 OK` in order to start sending the HTML stream. If a `notFound()` fires
    // mid-stream, Next.js cannot go back and change the status to 404. Instead, it
    // injects `<meta name="robots" content="noindex">`" (Next 16, `streaming.md`,
    // The HTTP contract). The layout above the boundary refuses a route it knows
    // by path; an id it cannot check without the query the page itself runs. So
    // this one stays a soft 404, and this case says so out loud.
    {
      path: `/${LOCALE}/movements/${UNKNOWN_ID}`,
      status: 200,
      title: title("transactions.detailTitle"),
      noindex: true,
      why: "a streamed notFound(): noindex in the body, 200 on the wire",
    },
    // The proxy sends a signed-in caller away from the login, and `bienvenida`
    // sends one with no claimed invite home. Both answer 200 at the dashboard,
    // which is what the follow reports.
    {
      path: `/${LOCALE}/login`,
      status: 200,
      title: title("common.appName"),
      landsOn: `/${LOCALE}`,
      why: "the proxy redirects a signed-in caller off the login",
    },
    {
      path: `/${LOCALE}/bienvenida`,
      status: 200,
      title: title("common.appName"),
      landsOn: `/${LOCALE}`,
      why: "no claimed membership, so the page sends the visitor home",
    },
    {
      path: `/${LOCALE}/onboarding`,
      status: 200,
      title: title("metadata.onboardingTitle"),
    },
    {
      path: `/${LOCALE}/onboarding/accounts`,
      status: 200,
      title: title("metadata.onboardingTitle"),
      landsOn: `/${LOCALE}/onboarding`,
      why: "step two presumes the fund from step one",
    },
    {
      path: `/${LOCALE}/onboarding/invite`,
      status: 200,
      title: title("metadata.onboardingTitle"),
      landsOn: `/${LOCALE}/onboarding`,
      why: "step three presumes the fund from step one",
    },
  ];
}

type HttpScope = {
  userId: string;
  accountId: string;
  categoryId: string;
  transactionId: string;
  debtAccountId: string;
};

/**
 * The rows the screens read. No group is created: RF-55 makes the members screen
 * a 404 for a caller without one, and that 404 is an assertion below.
 */
async function seedHttpScope(userId: string): Promise<HttpScope> {
  const scope: HttpScope = {
    userId,
    accountId: randomUUID(),
    categoryId: randomUUID(),
    transactionId: randomUUID(),
    debtAccountId: randomUUID(),
  };
  const planId = randomUUID();
  const settlementId = randomUUID();
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;

    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${scope.accountId}, ${userId}, 'Harness HTTP bank', 'asset', 'bank', 5000000, current_date)`;

    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${scope.categoryId}, ${userId}, 'Harness HTTP groceries', 'expense', '#4C8C4A')`;

    // Owner and creator are trigger-stamped from the claims above.
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
      values (${scope.transactionId}, ${scope.accountId}, 123400, current_date, 'Harness HTTP movement')`;

    // An income or expense carries at least one split, and the sum has to match
    // the amount; a constraint trigger refuses the movement otherwise (RF-69).
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${scope.transactionId}, ${scope.categoryId}, 123400)`;

    // A liability opened three months back, so its cut-off day has periods behind
    // it and the detail materialises a history to read (RF-84). It opens negative:
    // a debt owes, and every balance is derived (RNF-05, RNF-07).
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${scope.debtAccountId}, ${userId}, ${DEBT_NAME}, 'liability', 'card',
        -24000000, (current_date - interval '3 months')::date)`;

    await tx`
      insert into debt_terms (
        account_id, debt_kind, annual_rate, minimum_payment_cents,
        credit_limit_cents, statement_cut_off_day, payment_due_day)
      values (${scope.debtAccountId}, 'revolving', 0.2400, 600000, 50000000, 15, 5)`;

    await tx`
      insert into installment_plans (
        id, account_id, description, merchant, principal_cents,
        n_installments, frequency, start_date)
      values (${planId}, ${scope.debtAccountId}, 'Harness HTTP plan', 'Harness comercio',
        9000000, 3, 'monthly', (current_date - interval '2 months')::date)`;

    await tx`
      insert into installment_lines (plan_id, seq, due_date, amount_cents) values
        (${planId}, 1, (current_date - interval '2 months')::date, 3000000),
        (${planId}, 2, (current_date - interval '1 month')::date, 3000000),
        (${planId}, 3, current_date, 3000000)`;

    // The movement that settled the first line: an asset pays a liability (RF-16),
    // and the line points at it, which is the link the detail's cuotas table reads.
    await tx`
      insert into transactions (id, from_account_id, to_account_id, amount_cents, occurred_at, description)
      values (${settlementId}, ${scope.accountId}, ${scope.debtAccountId}, 3000000,
        (current_date - interval '2 months')::date, 'Harness HTTP abono')`;

    await tx`
      update installment_lines set paid_transaction_id = ${settlementId}
      where plan_id = ${planId} and seq = 1`;
  });

  track("accounts", scope.accountId);
  track("categories", scope.categoryId);
  track("transactions", scope.transactionId);
  // The lines go with the plan and the statements with the account: both cascade.
  track("installment_plans", planId);
  track("transactions", settlementId);
  track("debt_terms", scope.debtAccountId);
  track("accounts", scope.debtAccountId);

  return scope;
}

// Deliveries the webhook suite lands, dropped by hand: `ingest_deliveries` is
// append-only for the app and carries no cleanup entry in `fixtures.ts`.
const landedDeliveries: string[] = [];

// The identity the whole run measures and writes under, set once `main()`
// reads the session. The `finally` below needs it to bound its own deletes —
// this identity is `shared`, never `ephemeral`, so `cleanup()`'s per-identity
// drop never reaches it and the ingest tables the webhook suite fills would
// otherwise outlive every run.
let httpUserId: string | undefined;

async function guardSuite(routes: AppRoute[]): Promise<void> {
  for (const { path } of routes) {
    const response = await fetch(`${HARNESS_BASE_URL}${path}`, {
      redirect: "manual",
    });
    // A relative Location is as valid as an absolute one, so it is resolved
    // rather than parsed on its own.
    const location = response.headers.get("location");
    const target = location ? new URL(location, HARNESS_BASE_URL) : null;
    const carried = target?.searchParams.get("next");

    assert(
      next(`${path} without a session redirects to the login`),
      response.status === 307 &&
        target?.pathname === `/${LOCALE}/login` &&
        carried === path,
      `it answered ${response.status} to ${target?.pathname ?? "(no location)"} carrying next=${carried ?? "(none)"}`,
    );
  }

  const login = await get(`/${LOCALE}/login`);
  assert(
    next("the login itself answers without a session"),
    login.status === 200 && !login.errorShell,
    `it answered ${login.status} titled ${JSON.stringify(login.title)}`,
  );
}

async function renderSuite(cases: RenderCase[], cookie: string): Promise<void> {
  for (const expected of cases) {
    const seen = await get(expected.path, cookie);
    const landedOn = expected.landsOn ?? expected.path;
    // A refusal comes in the shell; a render never does. A refusal that arrived
    // too late for a status carries neither, and is read by its `noindex`.
    const bodyIsRight =
      expected.status === 404 ? seen.errorShell : !seen.errorShell;
    const indexingIsRight =
      expected.noindex === undefined || seen.noindex === expected.noindex;

    assert(
      next(`${expected.path} renders${expected.why ? ` — ${expected.why}` : ""}`),
      seen.status === expected.status &&
        seen.landedOn === landedOn &&
        seen.title === expected.title &&
        bodyIsRight &&
        indexingIsRight,
      `it answered ${seen.status} at ${seen.landedOn} titled ${JSON.stringify(seen.title)} over ${
        seen.errorShell ? "Next's refusal shell" : "its own screen"
      }, ${seen.noindex ? "marked noindex" : "indexable"}`,
    );
  }
}

// A page under the route group that no case names would go unrendered and unseen.
// Route handlers are excluded: they answer a download, not a document.
function coverageSuite(cases: RenderCase[], routes: AppRoute[]): void {
  const named = new Set(cases.map((one) => one.path));
  const missing = routes
    .filter((route) => route.page && !named.has(route.path))
    .map((route) => route.path);

  assert(
    next("every page under the route group is named by a render case"),
    missing.length === 0,
    missing.length === 0
      ? `${routes.length} routes walked, ${named.size} cases`
      : `unnamed: ${missing.join(", ")}`,
  );
}

async function localeSuite(cookie: string): Promise<void> {
  const seen = await get("/xx/inbox", cookie);

  assert(
    next("an unknown locale segment is not a route"),
    seen.status === 404,
    `it answered ${seen.status} at ${seen.landedOn}`,
  );
}

// What the webhook suite wrote and the audit viewer must never repeat: the hash
// the credential is resolved by, and the fragment that makes each run's SMS its
// own. Both live in the snapshot columns of the rows that suite left behind.
type WebhookSecrets = {
  credentialId: string;
  deliveryId: string;
  tokenHash: string;
  smsFragment: string;
  // RF-128 C3, asserted by the caller rather than here: `next()`'s counter is
  // read at call time (`docs/TRAPS.md`'s trap for `check-queries.ts`'s `Q`
  // applies here too), so an assertion mid-`webhookSuite` would renumber
  // every later `H` case. Landing the delivery here and asserting on it after
  // `timingSuite` keeps every existing number exactly where it prints today.
  centavosDelivery: {
    status: number;
    body: Record<string, unknown>;
    amountCents: number | null;
  };
};

/**
 * The ingest endpoint end to end: a credential the harness mints, one delivery,
 * the same text again landing nothing new, and a token that resolves to nothing.
 * The route answers 200 to both the first delivery and its repeat — the repeat is
 * told apart by `duplicate`, never by a status.
 */
async function webhookSuite(userId: string): Promise<WebhookSecrets> {
  const credentialId = randomUUID();
  const token = `whk_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into webhook_credentials (id, owner_user_id, name, token_hash)
      values (${credentialId}, ${userId}, 'Harness HTTP credential', ${tokenHash})`;
  });
  track("webhook_credentials", credentialId);

  // A verbatim T2 sample, its merchant made unique so each run hashes to its own
  // external reference; the date it names is what RF-98 is read back against.
  const smsFragment = randomUUID().slice(0, 8);
  const text = `Bancolombia: Compraste COP122.000,00 en BOLD CO ONLINE ${smsFragment} con tu T.Cred *4872, el 25/08/2026 a las 20:07. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.`;

  async function post(
    bearer: string,
    message: string = text,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${HARNESS_BASE_URL}/api/webhooks/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: message }),
    });

    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  const first = await post(token);
  if (typeof first.body.deliveryId === "string") {
    landedDeliveries.push(first.body.deliveryId);
  }
  assert(
    next("a delivery lands through the ingest endpoint"),
    first.status === 200 &&
      first.body.duplicate === false &&
      first.body.status === "pending" &&
      typeof first.body.deliveryId === "string",
    `it answered ${first.status} — ${JSON.stringify(first.body)}`,
  );

  const [landed] = await fixtureSql<{ occurredAt: string | null }[]>`
    select proposed_occurred_at::text as "occurredAt"
    from ingest_deliveries
    where id = ${String(first.body.deliveryId)}`;
  assert(
    next("the delivery is dated the day the message names, not the day it ran"),
    landed?.occurredAt === "2026-08-25",
    `it landed dated ${landed?.occurredAt ?? "(no row)"}`,
  );

  const repeat = await post(token);
  assert(
    next("the same text again lands nothing new"),
    repeat.status === 200 &&
      repeat.body.duplicate === true &&
      repeat.body.deliveryId === first.body.deliveryId,
    `it answered ${repeat.status} — ${JSON.stringify(repeat.body)}`,
  );

  const [{ count }] = await fixtureSql<{ count: string }[]>`
    select count(*)::text as count
    from ingest_deliveries
    where owner_user_id = ${userId} and credential_id = ${credentialId}`;
  assert(
    next("the repeat left one row, not two"),
    count === "1",
    `the credential holds ${count} deliveries`,
  );

  // RF-128: a bank amount past the thousands group carrying real centavos,
  // read the way the importer reads one — `parseAmount` on `rawPesos`
  // (`db/queries/webhook-ingest.ts`). Revert that call to the old
  // `parsePesos` + `pesosToCents` pair and this fifty-centavo figure comes
  // back null instead of kept: `parsePesos` refuses any amount that is not a
  // whole peso. Landed, not asserted, here — see `WebhookSecrets`.
  const centavosFragment = randomUUID().slice(0, 8);
  const centavosText = `Bancolombia: Compraste COP122.000,50 en BOLD CO ONLINE ${centavosFragment} con tu T.Cred *4872, el 26/08/2026 a las 09:15. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.`;
  const centavos = await post(token, centavosText);
  if (typeof centavos.body.deliveryId === "string") {
    landedDeliveries.push(centavos.body.deliveryId);
  }
  // Cast off `bigint`: postgres.js reads that column as a string, and the
  // caller's `===` needs the number the column actually stores.
  const [centavosRow] = await fixtureSql<{ amountCents: number | null }[]>`
    select proposed_amount_cents::int as "amountCents"
    from ingest_deliveries
    where id = ${typeof centavos.body.deliveryId === "string" ? centavos.body.deliveryId : ""}`;

  const unknown = await post(`whk_${randomBytes(32).toString("base64url")}`);
  assert(
    next("a token that resolves to nothing is refused"),
    unknown.status === 401 && unknown.body.error === "unauthorized",
    `it answered ${unknown.status} — ${JSON.stringify(unknown.body)}`,
  );

  await fixtureSql`
    update webhook_credentials set revoked_at = now() where id = ${credentialId}`;

  const revoked = await post(token);
  assert(
    next("the revoked credential is refused with the same generic answer"),
    revoked.status === 401 && revoked.body.error === "unauthorized",
    `it answered ${revoked.status} — ${JSON.stringify(revoked.body)}`,
  );

  return {
    credentialId,
    deliveryId: String(first.body.deliveryId),
    tokenHash,
    smsFragment,
    centavosDelivery: {
      status: centavos.status,
      body: centavos.body,
      amountCents: centavosRow?.amountCents ?? null,
    },
  };
}

/**
 * What the audit viewer puts on the wire (RF-53). The webhook suite has just
 * written the newest rows in the log, so its credential and its delivery are on
 * the first page: the payload names both records and carries neither the token
 * hash nor the bank message their snapshot columns hold.
 */
async function auditPayloadSuite(
  cookie: string,
  secrets: WebhookSecrets,
): Promise<void> {
  const response = await fetch(
    `${HARNESS_BASE_URL}/${LOCALE}/settings/audit`,
    { headers: { cookie } },
  );
  const body = await response.text();

  const named = [
    ["the credential", secrets.credentialId],
    ["the delivery", secrets.deliveryId],
  ].filter(([, id]) => !body.includes(id));

  assert(
    next("the audit page carries the rows the webhook suite just wrote"),
    response.status === 200 && named.length === 0,
    named.length === 0
      ? `it answered ${response.status} over ${body.length} bytes naming both records`
      : `it answered ${response.status} without ${named.map(([what]) => what).join(" or ")}`,
  );

  // The literal secrets, never a column name: a projection that stops selecting
  // them and a viewer that stops rendering them both read the same here.
  const leaked = [
    ["the credential's token hash", secrets.tokenHash],
    ["the delivery's bank message", secrets.smsFragment],
  ].filter(([, secret]) => body.includes(secret));

  assert(
    next("no audited snapshot rides the audit payload"),
    leaked.length === 0,
    leaked.length === 0
      ? "neither the token hash nor the message text appears in the response"
      : `the response carries ${leaked.map(([what]) => what).join(" and ")}`,
  );
}

// The 2 s of RNF-09, in the unit the measurement produces.
const RNF_09_BUDGET_MS = 2000;

// What `HARNESS_TARGET` may name. `next dev` compiles a route on demand, so a
// number measured there is about the compiler as much as the query plan; it is
// worth reporting, and it is labelled, but it is not the requirement's subject.
const TARGETS = {
  production: "a production build served by next start",
  dev: "next dev, which compiles on demand — NOT the requirement's subject",
} as const;

type Target = keyof typeof TARGETS;

function namedTarget(): Target | null {
  const named = process.env.HARNESS_TARGET;

  return named && named in TARGETS ? (named as Target) : null;
}

/**
 * How long every screen takes hot, and the one verdict this layer carries: RNF-09.
 *
 * The budget presumes a year of movements, so the verdict reads TWO preconditions
 * before it claims anything — the movements the measured user owns, counted in the
 * database, and `HARNESS_TARGET`, which names what is being served. Missing either,
 * it skips SAYING WHICH: a dashboard answering fast over an empty ledger meets
 * nothing, and a green line from that would be a lie about the requirement.
 */
async function timingSuite(
  cases: RenderCase[],
  cookie: string,
  userId: string,
): Promise<void> {
  for (const one of cases) {
    const started = Date.now();
    await get(one.path, cookie);
    console.log(`REPORT  ${one.path} answered hot in ${Date.now() - started} ms.`);
  }

  const samples: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const started = Date.now();
    await get(`/${LOCALE}`, cookie);
    samples.push(Date.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[2];

  console.log(
    `REPORT  the dashboard's median over five hot requests is ${median} ms (${samples.join(", ")}).`,
  );

  const movements = await countOwnedMovements(userId);
  const target = namedTarget();
  const label = next("the dashboard meets the RNF-09 budget");

  if (movements < YEAR_OF_MOVEMENTS) {
    skip(
      label,
      `the ledger holds ${movements} movements for the measured user, short of the ${YEAR_OF_MOVEMENTS} a year holds — run \`npm run seed:year\`; ${median} ms measured over what is there`,
    );
    return;
  }

  if (target === null) {
    skip(
      label,
      `HARNESS_TARGET names nothing measurable — set it to ${Object.keys(TARGETS).join(" or ")}; ${median} ms measured over ${movements} movements`,
    );
    return;
  }

  assert(
    label,
    median <= RNF_09_BUDGET_MS,
    `${median} ms median against a ${RNF_09_BUDGET_MS} ms budget, over ${movements} movements, on ${TARGETS[target]}`,
  );
}

async function main(): Promise<void> {
  await openRun("http", fixtureSql);
  const session = await harnessSession();
  const userId = session.user.id;
  httpUserId = userId;
  console.log(
    `REPORT  harness user ${userId} <${HARNESS_EMAIL}>, session ${
      mintedThisRun()
        ? "minted this run"
        : `reused from ${sessionFileName(HARNESS_EMAIL)}`
    }.`,
  );
  console.log(`REPORT  driving ${HARNESS_BASE_URL}.`);

  const scope = await seedHttpScope(userId);
  const cookie = await cookieHeader();
  const routes = appGroupRoutes(scope.transactionId);
  const cases = renderCases(scope);
  console.log("");

  await guardSuite(routes);
  console.log("");
  coverageSuite(cases, routes);
  await renderSuite(cases, cookie);
  console.log("");
  await localeSuite(cookie);
  const secrets = await webhookSuite(userId);
  await auditPayloadSuite(cookie, secrets);
  console.log("");
  await timingSuite(cases, cookie, userId);
  console.log("");
  // Asserted here, not inside `webhookSuite`, so this case's `H` number lands
  // after every one above instead of shifting them (RF-128 C3).
  assert(
    next("a delivery carrying centavos lands through the ingest endpoint"),
    secrets.centavosDelivery.status === 200 &&
      secrets.centavosDelivery.body.duplicate === false &&
      typeof secrets.centavosDelivery.body.deliveryId === "string",
    `it answered ${secrets.centavosDelivery.status} — ${JSON.stringify(secrets.centavosDelivery.body)}`,
  );
  assert(
    next("the delivery keeps the fifty centavos the message named"),
    secrets.centavosDelivery.amountCents === 12200050,
    // `null` here is a real answer (`parsePesos` refusing the fraction), not a
    // missing row — H64 already proved the row landed — so it prints as-is.
    `it landed proposed_amount_cents ${String(secrets.centavosDelivery.amountCents)}`,
  );
}

// The four headers every answer carries, so no other site frames a delete button
// or has a browser guess a type. Redirects are not probed: they carry no document.
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function missingHeaders(response: Response): string[] {
  return Object.entries(SECURITY_HEADERS)
    .filter(([name, value]) => response.headers.get(name) !== value)
    .map(([name]) => `${name}=${response.headers.get(name) ?? "(none)"}`);
}

async function securityHeadersSuite(): Promise<void> {
  const cookie = await cookieHeader();
  const probe = (path: string, signedIn: boolean) =>
    fetch(`${HARNESS_BASE_URL}${path}`, {
      redirect: "manual",
      headers: signedIn ? { cookie } : {},
    });

  const login = await probe(`/${LOCALE}/login`, false);
  const loginMissing = missingHeaders(login);
  assert(
    next("the signed-out login page forbids framing"),
    login.status === 200 &&
      login.headers.get("content-security-policy") === "frame-ancestors 'none'" &&
      login.headers.get("x-frame-options") === "DENY",
    `it answered ${login.status}, missing ${loginMissing.join(", ") || "nothing"}`,
  );

  const home = await probe(`/${LOCALE}`, true);
  assert(
    next("the signed-in page forbids framing and sniffing"),
    home.status === 200 &&
      home.headers.get("content-security-policy") === "frame-ancestors 'none'" &&
      home.headers.get("x-frame-options") === "DENY" &&
      home.headers.get("x-content-type-options") === "nosniff",
    `it answered ${home.status}, missing ${missingHeaders(home).join(", ") || "nothing"}`,
  );

  const refused = await probe(`/${LOCALE}/settings/members`, true);
  assert(
    next("a refused page (404) carries all four headers"),
    refused.status === 404 && missingHeaders(refused).length === 0,
    `it answered ${refused.status}, missing ${missingHeaders(refused).join(", ") || "nothing"}`,
  );

  const keepalive = await probe("/api/cron/keepalive", false);
  assert(
    next("a route handler's refusal carries all four headers"),
    keepalive.status === 401 && missingHeaders(keepalive).length === 0,
    `it answered ${keepalive.status}, missing ${missingHeaders(keepalive).join(", ") || "nothing"}`,
  );

  const policies = [login, home, refused, keepalive].map((response) =>
    response.headers.get("referrer-policy"),
  );
  assert(
    next("every probe sends the strict-origin-when-cross-origin referrer policy"),
    policies.every((value) => value === "strict-origin-when-cross-origin"),
    `they sent ${policies.map((value) => value ?? "(none)").join(", ")}`,
  );
}

// The proxy hands the shell its path through a request it builds. A caller's own
// `x-pathname` must neither refuse a page nor lift a refusal.
async function pathnameHeaderSuite(): Promise<void> {
  const cookie = await cookieHeader();
  const forged = (path: string, claimed: string) =>
    fetch(`${HARNESS_BASE_URL}${path}`, {
      redirect: "manual",
      headers: { cookie, "x-pathname": claimed },
    });

  const refusedStill = await forged(`/${LOCALE}/settings/members`, `/${LOCALE}/inbox`);
  assert(
    next("a forged x-pathname does not lift the members refusal"),
    refusedStill.status === 404,
    `it answered ${refusedStill.status}`,
  );

  const servedStill = await forged(`/${LOCALE}/inbox`, `/${LOCALE}/settings/members`);
  assert(
    next("a forged x-pathname does not refuse the inbox"),
    servedStill.status === 200,
    `it answered ${servedStill.status}`,
  );

  const source = readFileSync(resolve(process.cwd(), "proxy.ts"), "utf8");
  const writes = source.match(/request\.headers\.(set|delete)/g) ?? [];
  assert(
    next("the proxy never writes onto the incoming request's headers"),
    writes.length === 0,
    `proxy.ts holds ${writes.length} write(s) onto request.headers`,
  );
}

// Wrapped in an async IIFE (not top-level await) so the runner can transpile this
// to CJS and run it on any Node version, not only Node 22's native strip.
void (async () => {
  try {
    await main();
    await edgeSuite();
    await adjustmentTypeSuite();
    await securityHeadersSuite();
    await pathnameHeaderSuite();
    await failureRedirectSuite();
    await unreviewedExportSuite();
    await credentialDefaultCategorySuite();
  } catch (error) {
    assert(
      next("the run completed"),
      false,
      `it aborted — ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      if (landedDeliveries.length > 0) {
        await fixtureSql`delete from ingest_deliveries where id in ${fixtureSql(landedDeliveries)}`;
      }
      // The webhook suite's own leftovers, bounded to the lane identity: the
      // shape and merchant memory the ingest endpoint may have written. Under
      // `asOwner` so `capture_audit` stamps each delete with this user as
      // actor, which is what makes it reachable by `purgeAuditTrail` next.
      if (httpUserId) {
        const owner = httpUserId;
        await asOwner(owner, async (tx) => {
          await tx`delete from ingest_shapes where owner_user_id = ${owner}`;
          await tx`delete from ingest_merchants where owner_user_id = ${owner}`;
        });
        await purgeAuditTrail([owner]);
      }
      await cleanup();
    } catch (error) {
      assert(
        next("the fixtures were dropped"),
        false,
        `cleanup failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  report();
})();

// The ingest endpoint's other answers, the keepalive and the export's guard.
// Appended after the run's first suites: each case below owns the credential it
// drives, so no bucket and no delivery is shared with the cases above.

type EdgeReply = { status: number; body: Record<string, unknown> };

async function postRaw(
  headers: Record<string, string>,
  body: string,
): Promise<EdgeReply> {
  const response = await fetch(`${HARNESS_BASE_URL}/api/webhooks/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function edgeCredential(
  userId: string,
  options: {
    rateLimitPerMin?: number;
    defaultAccountId?: string;
    defaultCategoryId?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const token = `whk_${randomBytes(32).toString("base64url")}`;
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into webhook_credentials
        (id, owner_user_id, name, token_hash, rate_limit_per_min, default_account_id, default_category_id)
      values (${id}, ${userId}, 'Harness HTTP edge credential',
        ${createHash("sha256").update(token).digest("hex")},
        ${options.rateLimitPerMin ?? 60}, ${options.defaultAccountId ?? null},
        ${options.defaultCategoryId ?? null})`;
  });
  track("webhook_credentials", id);

  return token;
}

// M24: `?type=adjustment` reaches the list and the export (RF-23, RF-118, RF-138).
async function adjustmentTypeSuite(): Promise<void> {
  const userId = httpUserId;
  if (!userId) throw new Error("adjustmentTypeSuite ran before the session was read");
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });
  const tag = randomUUID().slice(0, 8);
  const accountName = `Harness M24 ${tag}`;
  const accountId = randomUUID();
  const categoryId = randomUUID();
  const expenseId = randomUUID();

  // The counted balance sits below the derived one, so the trigger books one
  // outgoing adjustment against the account (RF-137).
  const adjustmentId = await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${userId}, ${accountName}, 'asset', 'bank', 1000000, (now() at time zone 'America/Bogota')::date)`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${userId}, ${`Harness M24 cat ${tag}`}, 'expense', '#4C8C4A')`;
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
      values (${expenseId}, ${accountId}, 100000, (now() at time zone 'America/Bogota')::date, ${`Harness M24 gasto ${tag}`})`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${expenseId}, ${categoryId}, 100000)`;
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${accountId}, (now() at time zone 'America/Bogota')::date, 800000)`;
    const [row] = await tx<{ id: string }[]>`
      select t.id from transactions t
      where t.from_account_id = ${accountId} and t.reconciliation_id is not null`;
    return row?.id;
  });
  track("accounts", accountId);
  track("categories", categoryId);
  track("transactions", expenseId);
  if (adjustmentId) track("transactions", adjustmentId);
  assert(
    next("the seed books one expense and one reconciliation adjustment"),
    adjustmentId !== undefined,
    "the reconciliation booked no adjustment",
  );

  const cookie = await cookieHeader();
  const columns = messages.data.columns;
  const readSheet = async (type: string) => {
    const response = await fetch(
      `${HARNESS_BASE_URL}/${LOCALE}/settings/data/export?entities=transactions&type=${type}`,
      { headers: { cookie } },
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values as unknown[];
    const flagAt = header.indexOf(columns.adjustment);
    const accountAt = header.indexOf(columns.fromAccount);
    const rows: { account: string; flagged: boolean }[] = [];
    sheet.eachRow((row, number) => {
      if (number === 1) return;
      const cells = row.values as unknown[];
      const flag = cells[flagAt];
      rows.push({
        account: String(cells[accountAt] ?? ""),
        flagged: flag !== undefined && flag !== null && flag !== "" && flag !== false,
      });
    });
    return { status: response.status, flagAt, rows: rows.filter((one) => one.account === accountName) };
  };

  const adjusted = await readSheet("adjustment");
  assert(
    next("the export narrows to adjustments: one row, flagged in its adjustment column"),
    adjusted.status === 200 &&
      adjusted.flagAt > 0 &&
      adjusted.rows.length === 1 &&
      adjusted.rows[0].flagged,
    `status ${adjusted.status}, flag column ${adjusted.flagAt}, rows ${JSON.stringify(adjusted.rows)}`,
  );

  const spent = await readSheet("expense");
  assert(
    next("the export's expense leaves the adjustment out"),
    spent.status === 200 && spent.rows.length === 1 && !spent.rows[0].flagged,
    `status ${spent.status}, rows ${JSON.stringify(spent.rows)}`,
  );

  const page = await get(`/${LOCALE}/movements?type=adjustment`, cookie);
  assert(
    next("/movements?type=adjustment answers 200 and not the error shell"),
    page.status === 200 && !page.errorShell,
    `it answered ${page.status}, error shell ${page.errorShell}`,
  );
}

async function edgeSuite(): Promise<void> {
  const userId = httpUserId;
  if (!userId) throw new Error("edgeSuite ran before the session was read");
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  // Each run reads and sends its own merchant, so no earlier run's memory
  // answers for it. Uppercase keeps the fragment out of the kept tokens.
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const sms = (verb: string, merchant: string, tail = "4872"): string =>
    `Bancolombia: ${verb} COP12.000,00 en ${merchant} con tu T.Cred *${tail}, el 25/08/2026 a las 20:07.`;

  const stored = async (
    message: string,
  ): Promise<{
    direction: string | null;
    accountId: string | null;
    categoryId: string | null;
    source: string | null;
  } | null> => {
    const [row] = await fixtureSql<
      {
        direction: string | null;
        accountId: string | null;
        categoryId: string | null;
        source: string | null;
      }[]
    >`select proposed_direction as direction,
        proposed_account_id as "accountId", proposed_category_id as "categoryId",
        category_source as source
      from ingest_deliveries
      where owner_user_id = ${userId} and raw_text = ${message}`;

    return row ?? null;
  };

  const deliveriesOf = async (message: string): Promise<number> => {
    const [{ count }] = await fixtureSql<{ count: string }[]>`
      select count(*)::text as count from ingest_deliveries
      where owner_user_id = ${userId} and raw_text = ${message}`;

    return Number(count);
  };

  const remember = (id: string | undefined) => {
    if (id) landedDeliveries.push(id);
  };

  // Refusals before any body is read.
  const refusedText = sms("Compraste", `REFUSED ${tag}`);
  const refusedBody = JSON.stringify({ text: refusedText });
  const goodToken = await edgeCredential(userId);

  const noHeader = await postRaw({}, refusedBody);
  assert(
    next("an ingest POST without Authorization is refused and lands nothing"),
    noHeader.status === 401 &&
      noHeader.body.error === "unauthorized" &&
      (await deliveriesOf(refusedText)) === 0,
    `it answered ${noHeader.status} — ${JSON.stringify(noHeader.body)}`,
  );

  const basic = await postRaw({ authorization: `Basic ${goodToken}` }, refusedBody);
  assert(
    next("a Basic scheme carrying a valid token is refused"),
    basic.status === 401 &&
      basic.body.error === "unauthorized" &&
      (await deliveriesOf(refusedText)) === 0,
    `it answered ${basic.status} — ${JSON.stringify(basic.body)}`,
  );

  // Authentication comes first: a broken body from a stranger is a 401, never
  // the 400 that would tell a stranger the parser ran.
  const strangerBadJson = await postRaw(
    { authorization: `Bearer whk_${randomBytes(32).toString("base64url")}` },
    "{",
  );
  assert(
    next("a malformed body from an unknown token is a 401, not a 400"),
    strangerBadJson.status === 401 &&
      strangerBadJson.body.error === "unauthorized",
    `it answered ${strangerBadJson.status} — ${JSON.stringify(strangerBadJson.body)}`,
  );

  const badJson = await postRaw({ authorization: `Bearer ${goodToken}` }, "{");
  assert(
    next("a valid token with a malformed body is 400 invalid_json"),
    badJson.status === 400 && badJson.body.error === "invalid_json",
    `it answered ${badJson.status} — ${JSON.stringify(badJson.body)}`,
  );

  const badPayload = await postRaw({ authorization: `Bearer ${goodToken}` }, "{}");
  const fields = badPayload.body.fields as Record<string, unknown> | undefined;
  assert(
    next("a valid token with an empty object is 422 invalid_payload naming text"),
    badPayload.status === 422 &&
      badPayload.body.error === "invalid_payload" &&
      Array.isArray(fields?.text) &&
      fields.text.length > 0,
    `it answered ${badPayload.status} — ${JSON.stringify(badPayload.body)}`,
  );

  // The bucket: one request a minute, the second is over.
  const limited = await edgeCredential(userId, { rateLimitPerMin: 1 });
  const limitedFirstText = sms("Compraste", `LIMIT ONE ${tag}`);
  const limitedSecondText = sms("Compraste", `LIMIT TWO ${tag}`);
  const limitedFirst = await postRaw(
    { authorization: `Bearer ${limited}` },
    JSON.stringify({ text: limitedFirstText }),
  );
  remember(limitedFirst.body.deliveryId as string | undefined);
  const limitedSecond = await postRaw(
    { authorization: `Bearer ${limited}` },
    JSON.stringify({ text: limitedSecondText }),
  );
  remember(limitedSecond.body.deliveryId as string | undefined);
  assert(
    next("past rate_limit_per_min the request is 429 rate_limited and lands nothing"),
    limitedFirst.status === 200 &&
      limitedSecond.status === 429 &&
      limitedSecond.body.error === "rate_limited" &&
      (await deliveriesOf(limitedFirstText)) === 1 &&
      (await deliveriesOf(limitedSecondText)) === 0,
    `first ${limitedFirst.status}, second ${limitedSecond.status} — ${JSON.stringify(limitedSecond.body)}`,
  );

  // The proposal, read back from the stored delivery.
  const incomeText = `Bancolombia: Recibiste una transferencia de CARLOS ${tag} por $50.000 en tu cuenta *4872, el 25/08/2026.`;
  const expenseText = sms("Compraste", `GASTO ${tag}`);
  const proposals = await edgeCredential(userId);
  for (const text of [incomeText, expenseText]) {
    const reply = await postRaw(
      { authorization: `Bearer ${proposals}` },
      JSON.stringify({ text }),
    );
    remember(reply.body.deliveryId as string | undefined);
  }
  const income = await stored(incomeText);
  const expense = await stored(expenseText);
  assert(
    next("a message announcing a received transfer is proposed as income, a purchase as expense"),
    income?.direction === "income" && expense?.direction === "expense",
    `income landed ${income?.direction ?? "(no row)"}, purchase ${expense?.direction ?? "(no row)"}`,
  );

  // The account a message names by its last four. The credential's default is a
  // decoy: only the tail can pick the other account.
  const taken = await fixtureSql<{ lastFour: string }[]>`
    select last_four as "lastFour" from accounts
    where owner_user_id = ${userId} and last_four is not null`;
  const used = new Set(taken.map((row) => row.lastFour));
  const free: string[] = [];
  for (let n = 1000; free.length < 2 && n < 10000; n += 1) {
    const candidate = String(Math.floor(Math.random() * 9000) + 1000);
    if (!used.has(candidate) && !free.includes(candidate)) free.push(candidate);
  }
  const [namedTail, decoyTail] = free;
  const namedAccountId = randomUUID();
  const decoyAccountId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, last_four)
      values
        (${namedAccountId}, ${userId}, 'Harness HTTP named card', 'asset', 'bank', 0, current_date, ${namedTail}),
        (${decoyAccountId}, ${userId}, 'Harness HTTP decoy card', 'asset', 'bank', 0, current_date, ${decoyTail})`;
  });
  track("accounts", namedAccountId);
  track("accounts", decoyAccountId);
  const tailToken = await edgeCredential(userId, {
    defaultAccountId: decoyAccountId,
  });
  const tailText = sms("Compraste", `COLA ${tag}`, namedTail);
  const tailReply = await postRaw(
    { authorization: `Bearer ${tailToken}` },
    JSON.stringify({ text: tailText }),
  );
  remember(tailReply.body.deliveryId as string | undefined);
  const tailRow = await stored(tailText);
  assert(
    next("a message naming *last four proposes the account that carries them, not the default"),
    tailRow?.accountId === namedAccountId,
    `it proposed ${tailRow?.accountId ?? "(no row)"}, expected ${namedAccountId} (decoy ${decoyAccountId})`,
  );

  // Trust: nothing is prefilled after one approval; the second under the same
  // category makes the merchant trusted and the next message arrives filled.
  const categoryId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${userId}, 'Harness HTTP trusted', 'expense', '#4C8C4A')`;
  });
  track("categories", categoryId);
  const merchantLabel = `TIENDA ${tag}`;
  const trustToken = await edgeCredential(userId);
  const approve = () =>
    asOwner(userId, async (tx) => {
      await tx`select private.remember_ingest_merchant(${merchantLabel}, ${merchantLabel}, ${categoryId})`;
    });
  const trustText = (n: number) =>
    `Bancolombia: Compraste COP${n}.000,00 en ${merchantLabel} con tu T.Cred *4872, el 25/08/2026 a las 20:07.`;
  const arrive = async (text: string) => {
    const reply = await postRaw(
      { authorization: `Bearer ${trustToken}` },
      JSON.stringify({ text }),
    );
    remember(reply.body.deliveryId as string | undefined);

    return stored(text);
  };

  const beforeAny = await arrive(trustText(11));
  await approve();
  const afterOne = await arrive(trustText(12));
  await approve();
  const afterTwo = await arrive(trustText(13));
  assert(
    next("a merchant approved twice under one category prefills it; once, or never, does not"),
    beforeAny?.categoryId === null &&
      afterOne?.categoryId === null &&
      afterTwo?.categoryId === categoryId &&
      afterTwo?.source === "merchant",
    `categories landed ${beforeAny?.categoryId ?? "null"} / ${afterOne?.categoryId ?? "null"} / ${afterTwo?.categoryId ?? "null"} (source ${afterTwo?.source ?? "null"})`,
  );

  // The keepalive.
  const keepalive = (authorization?: string) =>
    fetch(`${HARNESS_BASE_URL}/api/cron/keepalive`, {
      headers: authorization ? { authorization } : undefined,
    });
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not in the harness environment");

  const keepNone = await keepalive();
  const keepWrong = await keepalive(`Bearer ${secret}x`);
  const keepEmpty = await keepalive("Bearer ");
  assert(
    next("the keepalive refuses no header, a wrong secret and an empty one"),
    keepNone.status === 401 && keepWrong.status === 401 && keepEmpty.status === 401,
    `no header ${keepNone.status}, wrong ${keepWrong.status}, empty ${keepEmpty.status}`,
  );

  const keepRight = await keepalive(`Bearer ${secret}`);
  const keepBody = (await keepRight.json()) as Record<string, unknown>;
  assert(
    next("the keepalive answers 200 ok: true to the right secret"),
    keepRight.status === 200 && keepBody.ok === true,
    `it answered ${keepRight.status} — ${JSON.stringify(keepBody)}`,
  );

  // The export, with no session: the proxy turns it away before a file exists.
  const exported = await fetch(`${HARNESS_BASE_URL}/${LOCALE}/settings/data/export`, {
    redirect: "manual",
  });
  const exportedTo = exported.headers.get("location");
  assert(
    next("the export without a session redirects to the login and sends no file"),
    exported.status === 307 &&
      new URL(exportedTo ?? "/", HARNESS_BASE_URL).pathname === `/${LOCALE}/login` &&
      exported.headers.get("content-disposition") === null &&
      !(exported.headers.get("content-type") ?? "").includes("spreadsheet"),
    `it answered ${exported.status} to ${exportedTo ?? "(no location)"} typed ${exported.headers.get("content-type") ?? "(none)"}`,
  );
}

// RF-01: a failed landing that clears a stale session cookie rides the no-store
// directives Auth hands back; without them a CDN may cache the `Set-Cookie`.
// A redirect that sets no cookie (`linkOtherBrowser`, which never asks Auth) has
// nothing to protect and carries none.
async function failureRedirectSuite(): Promise<void> {
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
  const stale = {
    access_token: "a.b.c",
    refresh_token: "not-a-refresh-token",
    expires_at: 1000,
    expires_in: 1,
    token_type: "bearer",
    user: { id: "00000000-0000-0000-0000-000000000000" },
  };
  const sessionCookie = `sb-${host}-auth-token=base64-${Buffer.from(JSON.stringify(stale)).toString("base64url")}`;
  const verifierCookie = `sb-${host}-auth-token-code-verifier=base64-${Buffer.from(JSON.stringify("abc")).toString("base64url")}`;

  const land = async (query: string, cookie: string) => {
    const response = await fetch(`${HARNESS_BASE_URL}/auth/confirm?${query}`, {
      redirect: "manual",
      headers: { cookie },
    });

    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      cacheControl: response.headers.get("cache-control") ?? "",
      clearsSession: response.headers.getSetCookie().some((one) => one.startsWith(`sb-${host}-auth-token=;`)),
    };
  };

  const byHash = await land("token_hash=abc&type=magiclink", sessionCookie);
  assert(
    next("a rejected token_hash link lands on the login with linkInvalid and says no-store"),
    [302, 307].includes(byHash.status) &&
      byHash.location.endsWith("/es/login?error=linkInvalid") &&
      byHash.clearsSession &&
      byHash.cacheControl.includes("no-store"),
    `it answered ${byHash.status} to ${byHash.location}, cache-control «${byHash.cacheControl}», clears session ${byHash.clearsSession}`,
  );

  const byCode = await land("code=abc", `${sessionCookie}; ${verifierCookie}`);
  assert(
    next("a rejected code link lands on the login with linkInvalid and says no-store"),
    [302, 307].includes(byCode.status) &&
      byCode.location.endsWith("/es/login?error=linkInvalid") &&
      byCode.clearsSession &&
      byCode.cacheControl.includes("no-store"),
    `it answered ${byCode.status} to ${byCode.location}, cache-control «${byCode.cacheControl}», clears session ${byCode.clearsSession}`,
  );

  const otherBrowser = await land("code=abc", sessionCookie);
  assert(
    next("a code opened where no verifier was set lands on the login with linkOtherBrowser"),
    [302, 307].includes(otherBrowser.status) && otherBrowser.location.endsWith("/es/login?error=linkOtherBrowser"),
    `it answered ${otherBrowser.status} to ${otherBrowser.location}`,
  );
}

// RF-118: the export carries the movement list's own filters, `unreviewed=1`
// among them, so the sheet holds only the movements awaiting review.
async function unreviewedExportSuite(): Promise<void> {
  const userId = httpUserId;
  if (!userId) throw new Error("unreviewedExportSuite ran before the session was read");
  const claims = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
  const tag = randomUUID().slice(0, 8);
  const accountId = randomUUID();
  const categoryId = randomUUID();
  const waiting = `Harness X04 por revisar ${tag}`;
  const reviewed = `Harness X04 revisado ${tag}`;
  const plain = `Harness X04 manual ${tag}`;
  const ids = { waiting: randomUUID(), reviewed: randomUUID(), plain: randomUUID() };

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${userId}, ${`Harness X04 ${tag}`}, 'asset', 'bank', 1000000, (now() at time zone 'America/Bogota')::date)`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${userId}, ${`Harness X04 cat ${tag}`}, 'expense', '#4C8C4A')`;
    for (const [id, description] of [
      [ids.waiting, waiting],
      [ids.reviewed, reviewed],
      [ids.plain, plain],
    ]) {
      await tx`
        insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
        values (${id}, ${accountId}, 10000, (now() at time zone 'America/Bogota')::date, ${description})`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${id}, ${categoryId}, 10000)`;
    }
  });
  track("accounts", accountId);
  track("categories", categoryId);
  for (const id of Object.values(ids)) track("transactions", id);
  await asOwner(userId, async (tx) => {
    await tx`update transactions set awaiting_counterparty = true where id in (${ids.waiting}, ${ids.reviewed})`;
    await tx`update transactions set reviewed_at = now() where id = ${ids.reviewed}`;
  });

  const cookie = await cookieHeader();
  const sheetOf = async (query: string): Promise<string[]> => {
    const response = await fetch(`${HARNESS_BASE_URL}/${LOCALE}/settings/data/export?entities=transactions${query}`, {
      headers: { cookie },
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const sheet = workbook.worksheets[0];
    const at = (sheet.getRow(1).values as unknown[]).indexOf(messages.data.columns.description);
    const found: string[] = [];
    sheet.eachRow((row, number) => {
      const text = String((row.values as unknown[])[at] ?? "");
      if (number > 1 && text.includes(tag)) found.push(text);
    });

    return found.sort();
  };

  const everything = await sheetOf("");
  assert(
    next("the unfiltered export holds the waiting, the reviewed and the manual movement"),
    everything.length === 3,
    `it held ${JSON.stringify(everything)}`,
  );

  const onlyWaiting = await sheetOf("&unreviewed=1");
  assert(
    next("the export with unreviewed=1 holds only the movement awaiting review"),
    onlyWaiting.length === 1 && onlyWaiting[0] === waiting,
    `it held ${JSON.stringify(onlyWaiting)}`,
  );
}

// RF-86: a message the interpreter cannot categorize lands proposed under the
// credential's default category, and says so; a credential without one proposes none.
async function credentialDefaultCategorySuite(): Promise<void> {
  const userId = httpUserId;
  if (!userId) throw new Error("credentialDefaultCategorySuite ran before the session was read");
  const claims = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const categoryId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${userId}, ${`Harness X06 ${tag}`}, 'expense', '#4C8C4A')`;
  });
  track("categories", categoryId);

  const deliver = async (token: string, merchant: string) => {
    const text = `Bancolombia: Compraste COP12.000,00 en ${merchant} con tu T.Cred *4872, el 25/08/2026 a las 20:07.`;
    const reply = await postRaw({ authorization: `Bearer ${token}` }, JSON.stringify({ text }));
    if (typeof reply.body.deliveryId === "string") landedDeliveries.push(reply.body.deliveryId);
    const [row] = await fixtureSql<{ categoryId: string | null; source: string | null }[]>`
      select proposed_category_id as "categoryId", category_source as source
      from ingest_deliveries where owner_user_id = ${userId} and raw_text = ${text}`;

    return { status: reply.status, row };
  };

  const withDefault = await deliver(await edgeCredential(userId, { defaultCategoryId: categoryId }), `ZXQ DEFAULT ${tag}`);
  assert(
    next("a delivery on a credential with a default category is proposed under it, sourced credential_default"),
    withDefault.status === 200 &&
      withDefault.row?.categoryId === categoryId &&
      withDefault.row?.source === "credential_default",
    `it answered ${withDefault.status}, landed ${JSON.stringify(withDefault.row)}`,
  );

  const without = await deliver(await edgeCredential(userId), `ZXQ BARE ${tag}`);
  assert(
    next("a delivery on a credential with no default category is proposed under none"),
    without.status === 200 && without.row?.categoryId === null && without.row?.source === null,
    `it answered ${without.status}, landed ${JSON.stringify(without.row)}`,
  );
}
