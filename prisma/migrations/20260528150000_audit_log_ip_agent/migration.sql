-- Capture client IP + user agent on every audit log entry so the admin
-- activity log can show *who did what from where*. Also relax
-- performed_by to nullable so we can log LOGIN_FAILED (no authenticated
-- user yet) and future webhook-triggered actions.
ALTER TABLE "audit_logs"
  ADD COLUMN "ip_address" TEXT,
  ADD COLUMN "user_agent" TEXT,
  ALTER COLUMN "performed_by" DROP NOT NULL;
