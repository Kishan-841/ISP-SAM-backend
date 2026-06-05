-- Audit log retention. The main audit_logs table is append-only with no
-- archival job; over years it'll bloat into the millions of rows and
-- /audit queries will get slower.
--
-- Strategy: keep a `audit_logs_archive` table with the SAME shape, plus
-- an `archived_at` timestamp. An admin-callable endpoint moves rows
-- older than N months into it inside a transaction. The /audit page and
-- /accounts/:id journey continue reading from `audit_logs` only — they
-- get fast scans. Compliance / forensic queries that need historical
-- data hit the archive table explicitly.
--
-- Schema notes:
--   - No FK from notification_states to this table — the live FK targets
--     audit_logs only. Notification_states rows referencing soon-to-be-
--     archived audit rows are deleted by Postgres CASCADE on the parent
--     row delete (which fires after the archive copy). That's intended:
--     once we archive a year-old notification audit row, the user's
--     "read/dismissed" overlay is no longer relevant.
--   - performed_by is nullable here too (matches the live table after
--     migration 20260528150000).
CREATE TABLE "audit_logs_archive" (
  "id"           UUID                      NOT NULL PRIMARY KEY,
  "entity_type"  TEXT                      NOT NULL,
  "entity_id"    UUID                      NOT NULL,
  "action"       TEXT                      NOT NULL,
  "performed_by" UUID,
  "ip_address"   TEXT,
  "user_agent"   TEXT,
  "payload"      JSONB,
  "timestamp"    TIMESTAMPTZ(6)            NOT NULL,
  "archived_at"  TIMESTAMPTZ(6)            NOT NULL DEFAULT now()
);

-- Index by entity_type + entity_id so forensic lookups against the
-- archive are still cheap when needed.
CREATE INDEX "audit_logs_archive_entity_type_entity_id_idx"
  ON "audit_logs_archive"("entity_type", "entity_id");

-- Index by performed_by so "show me everything user X ever did" queries
-- can extend into the archive.
CREATE INDEX "audit_logs_archive_performed_by_idx"
  ON "audit_logs_archive"("performed_by");

-- Index by timestamp so range queries (e.g. "Q1 2026 logins") are fast.
CREATE INDEX "audit_logs_archive_timestamp_idx"
  ON "audit_logs_archive"("timestamp");
