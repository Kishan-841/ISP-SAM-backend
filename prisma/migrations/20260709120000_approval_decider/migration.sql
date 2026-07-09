-- Final-approver identity + timestamp on a BASE commercial change, mirroring
-- the existing rejected_by / rejected_at columns. Lets the Approved history
-- tab show who approved and when without joining audit_logs.
ALTER TABLE "commercial_changes"
  ADD COLUMN IF NOT EXISTS "approved_by" UUID,
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ(6);
