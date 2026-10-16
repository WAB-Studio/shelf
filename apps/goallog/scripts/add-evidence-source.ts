// Upserts `goals.evidence_sources` from `SOURCE_ROWS`, or from one row given
// as `--key k --label-key sources.x --unit u`. The catalogue is read-only to
// `authenticated`, so this runs with the migration credential. Running it
// again changes nothing: a row already equal is not even rewritten.
import postgres from "postgres";

import { readerFor } from "../lib/evidence/registry";
import { SOURCE_ROWS, type EvidenceSourceRow } from "../lib/evidence/source-rows";
import { sourceKey } from "@/i18n/translator";

type Sql = ReturnType<typeof postgres>;

export async function upsertSources(sql: Sql, rows: readonly EvidenceSourceRow[]): Promise<number> {
  let changed = 0;
  for (const row of rows) {
    const done = await sql`
      insert into goals.evidence_sources (key, label_key, unit)
      values (${row.key}, ${row.labelKey}, ${row.unit})
      on conflict (key) do update
        set label_key = excluded.label_key, unit = excluded.unit
        where (goals.evidence_sources.label_key, goals.evidence_sources.unit)
          is distinct from (excluded.label_key, excluded.unit)
      returning id`;
    changed += done.length;
  }
  return changed;
}

function declared(argv: string[]): EvidenceSourceRow[] {
  const flag = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const key = flag("key");
  if (key === undefined) return [...SOURCE_ROWS];
  const labelKey = flag("label-key");
  const unit = flag("unit");
  if (!labelKey || !unit) throw new Error("--key needs --label-key and --unit");
  return [{ key, labelKey: sourceKey(labelKey), unit }];
}

async function main() {
  const rows = declared(process.argv.slice(2));
  for (const row of rows) {
    if (!readerFor(row.key)) throw new Error(`no reader registered for ${row.key}`);
  }
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const changed = await upsertSources(sql, rows);
    console.log(`evidence_sources: ${rows.length} declared, ${changed} written`);
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
