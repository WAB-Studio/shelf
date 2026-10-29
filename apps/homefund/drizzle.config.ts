import { defineConfig } from "drizzle-kit";

// Runs outside Next.js, so `lib/env.ts` is unavailable and `process.env` is read directly.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  dbCredentials: {
    // Session pooler: DDL and advisory locks need a connection that is not swapped mid-transaction.
    url: process.env.MIGRATION_DATABASE_URL!,
  },
  // `public`, `auth`, `storage` and the rest of Supabase's schemas are not ours to diff.
  schemaFilter: ["finances"],
  casing: "snake_case",
  // Teaches drizzle-kit which roles already exist, so it never emits `create role`.
  entities: { roles: { provider: "supabase" } },
  // Keeps the bookkeeping table out of `public`, where the automatic-RLS trigger fires.
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
});
