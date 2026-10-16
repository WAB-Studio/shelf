import { pgSchema } from "drizzle-orm/pg-core";

// Every table this app owns lives here. orbit's own live in `finances`
// (apps/orbit/db/schema/_schema.ts) — same database, two schemas, no name clash.
export const reading = pgSchema("reading");
