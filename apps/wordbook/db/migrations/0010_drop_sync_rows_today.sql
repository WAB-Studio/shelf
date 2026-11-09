-- 0009's `sync_gate` took over the day's count; nothing has called this one since, and `authenticated` still held EXECUTE.
DROP FUNCTION "reading"."sync_rows_today"(uuid);
