// Proves RP-146 against the local database: TimeLog's `app_seconds` rows reach
// a reader under the person's own settle, in minutes per civil day, and
// another person's rows do not (the policy underneath decides, RNP-05). One
// statement serves every TimeLog source in the fan (RNP-03).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { EvidenceDay } from "../lib/day/types";
import { readerFor } from "../lib/evidence/registry";
import { withSettledTransaction } from "../lib/settled-transaction";
import { TIMELOG_SOURCES } from "../lib/evidence/timelog-apps";

async function main() {
  const admin = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const app = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(app);
  const me = randomUUID();
  const other = randomUUID();
  try {
    for (const id of [me, other]) {
      await admin`insert into auth.users (id, aud, role, email) values (${id}, 'authenticated', 'authenticated', ${`${id}@check-timelog.invalid`})`;
    }
    await admin`
      insert into timelog.app_seconds (user_id, device, day, app, seconds) values
        (${me}, 'pc', '2026-10-01', 'Code.exe', 3600),
        (${me}, 'laptop', '2026-10-01', 'Code.exe', 600),
        (${me}, 'pc', '2026-10-01', 'chrome.exe', 1800),
        (${me}, 'pc', '2026-10-02', 'WindowsTerminal.exe', 1200),
        (${other}, 'pc', '2026-10-01', 'Code.exe', 7200)`;

    const read = (key: string) =>
      withSettledTransaction<unknown, EvidenceDay[]>(
        { claims: { sub: me, role: "authenticated" } },
        "check-timelog",
        "reading, public",
        (cb) => db.transaction(cb),
        (tx, statement) => (tx as typeof db).execute(statement),
        (tx) => readerFor(key)!({ personId: me, from: "2026-10-01", to: "2026-10-31", zone: "America/Bogota", tx: tx as never }),
      );

    const vscode = await read("timelog_app_vscode");
    assert.deepEqual(vscode.map((d) => [d.day, d.quantity, d.unit]), [["2026-10-01", 70, "minutos"]], "two devices add, the other person's 120 min never appear");
    const total = await read("timelog_total");
    assert.deepEqual(total.map((d) => [d.day, d.quantity]), [["2026-10-01", 100], ["2026-10-02", 20]]);
    const terminal = await read("timelog_app_terminal");
    assert.deepEqual(terminal.map((d) => [d.day, d.quantity]), [["2026-10-02", 20]]);

    const statements: string[] = [];
    const counting = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, debug: (_c, query) => statements.push(query) });
    const countDb = drizzle(counting);
    await withSettledTransaction(
      { claims: { sub: me, role: "authenticated" } },
      "check-timelog",
      "reading, public",
      (cb) => countDb.transaction(cb),
      (tx, statement) => (tx as typeof countDb).execute(statement),
      async (tx) => {
        await Promise.all(TIMELOG_SOURCES.map((s) => readerFor(s.key)!({ personId: me, from: "2026-10-01", to: "2026-10-31", zone: "America/Bogota", tx: tx as never })));
        return null;
      },
    );
    await counting.end();
    const selects = statements.filter((q) => /timelog.*app_seconds/i.test(q));
    assert.equal(selects.length, 1, `${TIMELOG_SOURCES.length} sources paid ${selects.length} reads of app_seconds`);
    console.log("check-timelog: ok");
  } finally {
    await admin`delete from auth.users where id in (${me}, ${other})`;
    await admin.end();
    await app.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
