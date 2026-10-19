// The single entry point drizzle-kit diffs and `db/client.ts` registers. The
// `goals` PgSchema object itself is not re-exported, so the schema diff never
// sees a schema to create and `CREATE SCHEMA` stays hand-written in 0000.
export * from "./goals";
export * from "./phases";
export * from "./evidence-sources";
export * from "./commitments";
export * from "./one-offs";
export * from "./facts";
export * from "./month-budgets";
export * from "./model-calls";
export * from "./access-tokens";
export * from "./oauth-clients";
export * from "./oauth-codes";
export * from "./oauth-refresh";
export * from "./oauth-calls";
export * from "./allowed-emails";
export * from "./sign-in-claims";
export * from "./write-receipts";
