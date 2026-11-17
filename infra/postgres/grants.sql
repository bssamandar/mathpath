-- Privileges of the application role, applied after every migration by
-- infra/deploy.sh (security plan C-37; database-schema.md, audit_log).
-- Idempotent: safe to run any number of times.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mathpath_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mathpath_app;

-- The audit log is append-only for the application. The trigger in the
-- identity migration also refuses changes; this makes it a privilege check
-- that runs before any trigger.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM mathpath_app;

-- Only the migration step changes the migration bookkeeping.
REVOKE ALL ON kysely_migration, kysely_migration_lock FROM mathpath_app;
