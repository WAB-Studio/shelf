-- A deleted member leaves their accounts without a holder; the group column stays, so only the holder is nulled.
ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_holder_member_fk";--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_holder_member_fk" FOREIGN KEY ("holder_member_id","group_id") REFERENCES "finances"."group_members"("id","group_id") ON DELETE set null ("holder_member_id") ON UPDATE no action;
