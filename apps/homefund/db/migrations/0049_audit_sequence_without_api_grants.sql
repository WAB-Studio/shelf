-- The live database holds no API-role grant on the audit sequence; a database built from the
-- migrations inherited them from the platform's default privileges. Idempotent on production.
REVOKE ALL ON SEQUENCE finances.audit_log_id_seq FROM anon, authenticated, service_role;
