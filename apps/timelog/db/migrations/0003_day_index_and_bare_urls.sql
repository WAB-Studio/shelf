CREATE INDEX "app_seconds_user_id_day_idx" ON "timelog"."app_seconds" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "claude_code_seconds_user_id_day_idx" ON "timelog"."claude_code_seconds" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "claude_sessions_user_id_day_idx" ON "timelog"."claude_sessions" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "page_seconds_user_id_day_idx" ON "timelog"."page_seconds" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "site_seconds_user_id_day_idx" ON "timelog"."site_seconds" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "window_seconds_user_id_day_idx" ON "timelog"."window_seconds" USING btree ("user_id","day");--> statement-breakpoint
-- NOT VALID: production rows were never scanned for credentials; the check binds every new and updated row, and `VALIDATE CONSTRAINT` follows once they are cleaned.
ALTER TABLE "timelog"."page_seconds" ADD CONSTRAINT "page_seconds_url_no_credentials" CHECK ("timelog"."page_seconds"."url" !~ '^https?://[^/]*@') NOT VALID;