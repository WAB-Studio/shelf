import { defineConfig } from "drizzle-kit";

// Runs outside Next.js, so `lib/env.ts` is unavailable and `process.env` is read directly.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL! },
  // The other apps' schemas are not ours to diff.
  schemaFilter: ["timelog"],
  casing: "snake_case",
  entities: { roles: { provider: "supabase" } },
  // Its own bookkeeping table, so this sequence never competes with another app's for the next `idx`.
  migrations: { schema: "drizzle", table: "__drizzle_migrations_timelog" },
});
