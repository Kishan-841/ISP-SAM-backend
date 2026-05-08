-- Per-user overlay for the notification feed. Audit log rows are global;
-- this table records which user has read or dismissed which row.

CREATE TABLE "notification_states" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "audit_log_id" UUID NOT NULL,
  "read_at" TIMESTAMPTZ(6),
  "dismissed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "notification_states_pkey" PRIMARY KEY ("id")
);

-- Each user can have at most one state row per audit-log entry.
CREATE UNIQUE INDEX "notification_states_user_id_audit_log_id_key"
  ON "notification_states"("user_id", "audit_log_id");

-- Hot read paths: "my unread/active notifications".
CREATE INDEX "notification_states_user_id_dismissed_at_idx"
  ON "notification_states"("user_id", "dismissed_at");
CREATE INDEX "notification_states_user_id_read_at_idx"
  ON "notification_states"("user_id", "read_at");

ALTER TABLE "notification_states"
  ADD CONSTRAINT "notification_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_states"
  ADD CONSTRAINT "notification_states_audit_log_id_fkey"
  FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
