ALTER TABLE "finances"."accounts" ADD COLUMN "holder_member_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_id_group_unique" ON "finances"."group_members" USING btree ("id","group_id");--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_holder_member_fk" FOREIGN KEY ("holder_member_id","group_id") REFERENCES "finances"."group_members"("id","group_id") ON DELETE set null ("holder_member_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_holder_member_id_idx" ON "finances"."accounts" USING btree ("holder_member_id");--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_holder_in_fund" CHECK ("finances"."accounts"."holder_member_id" is null or "finances"."accounts"."group_id" is not null);--> statement-breakpoint
GRANT INSERT (holder_member_id), UPDATE (holder_member_id) ON TABLE "finances"."accounts" TO authenticated;
