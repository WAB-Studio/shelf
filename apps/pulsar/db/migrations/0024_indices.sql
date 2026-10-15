CREATE INDEX IF NOT EXISTS "goals_user_id_position_idx" ON "goals"."goals" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phases_user_id_idx" ON "goals"."phases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phases_goal_id_idx" ON "goals"."phases" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commitments_goal_id_idx" ON "goals"."commitments" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "one_offs_user_id_position_idx" ON "goals"."one_offs" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "one_offs_user_id_day_idx" ON "goals"."one_offs" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "one_offs_goal_id_idx" ON "goals"."one_offs" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "one_offs_parent_id_idx" ON "goals"."one_offs" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facts_goal_id_day_idx" ON "goals"."facts" USING btree ("goal_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "month_budgets_user_id_idx" ON "goals"."month_budgets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_codes_user_id_idx" ON "goals"."oauth_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_codes_client_id_idx" ON "goals"."oauth_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_codes_access_token_id_idx" ON "goals"."oauth_codes" USING btree ("access_token_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_access_token_id_idx" ON "goals"."oauth_refresh" USING btree ("access_token_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_client_id_idx" ON "goals"."oauth_refresh" USING btree ("client_id");