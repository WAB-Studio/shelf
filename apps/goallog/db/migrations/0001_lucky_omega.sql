-- drizzle-kit does not diff a GRANT: `one_offs_delete_self` (0000) has stood
-- inert since the table was created, because Supabase revokes ALL from every
-- role at CREATE TABLE and 0000 never re-granted DELETE — RP-22 was not
-- built yet. Hand-written, the way 0000's own GRANT block is.
GRANT DELETE ON TABLE "goals"."one_offs" TO "authenticated";
