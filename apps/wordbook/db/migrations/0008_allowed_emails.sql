CREATE TABLE "reading"."allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_emails_email_shape" CHECK ("reading"."allowed_emails"."email" = lower(btrim("reading"."allowed_emails"."email")) and position('@' in "reading"."allowed_emails"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "reading"."allowed_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- RL-69, hand-written: drizzle-kit diffs neither a GRANT nor a seed. Read by the server's own connection alone.
REVOKE ALL ON TABLE "reading"."allowed_emails" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
-- Whoever already keeps a record here keeps asking for a link. An address the CHECK would refuse is left out
-- rather than failing the migration.
INSERT INTO "reading"."allowed_emails" ("email")
SELECT DISTINCT lower(btrim(u.email))
FROM auth.users u
WHERE u.email IS NOT NULL
  AND position('@' in lower(btrim(u.email))) > 1
  AND (
    EXISTS (SELECT 1 FROM reading.lookups l WHERE l.user_id = u.id)
    OR EXISTS (SELECT 1 FROM reading.devices d WHERE d.user_id = u.id)
  )
ON CONFLICT ("email") DO NOTHING;
