-- Add PENDING_QUICK_APPROVAL contract status for accounts whose quick
-- disconnect request is awaiting CRM Admin's decision.
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'PENDING_QUICK_APPROVAL';

-- Quick-disconnect workflow columns on commercial_changes. All nullable so
-- existing rows stay valid. `disconnection_mode` is NULL for non-disconnection
-- rows; for disconnection rows it's 'NORMAL' (default) or 'QUICK'.
ALTER TABLE "commercial_changes"
  ADD COLUMN IF NOT EXISTS "disconnection_mode"          TEXT,
  ADD COLUMN IF NOT EXISTS "quick_requested_days"        INTEGER,
  ADD COLUMN IF NOT EXISTS "quick_approval_reason"       TEXT,
  ADD COLUMN IF NOT EXISTS "quick_approval_decision"     TEXT,
  ADD COLUMN IF NOT EXISTS "quick_approval_decided_at"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "quick_approval_decided_by"   TEXT,
  ADD COLUMN IF NOT EXISTS "quick_approval_note"         TEXT;

-- Guard rails enforced at the DB layer so a buggy caller can't end up with
-- inconsistent rows. Postgres < 16 doesn't support `ADD CONSTRAINT IF NOT
-- EXISTS`; wrap in a DO block to make the migration safely re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commercial_changes_disconnection_mode_check') THEN
    ALTER TABLE "commercial_changes"
      ADD CONSTRAINT "commercial_changes_disconnection_mode_check"
      CHECK ("disconnection_mode" IS NULL OR "disconnection_mode" IN ('NORMAL', 'QUICK'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commercial_changes_quick_requested_days_check') THEN
    ALTER TABLE "commercial_changes"
      ADD CONSTRAINT "commercial_changes_quick_requested_days_check"
      CHECK ("quick_requested_days" IS NULL OR ("quick_requested_days" BETWEEN 1 AND 15));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commercial_changes_quick_approval_decision_check') THEN
    ALTER TABLE "commercial_changes"
      ADD CONSTRAINT "commercial_changes_quick_approval_decision_check"
      CHECK ("quick_approval_decision" IS NULL OR "quick_approval_decision" IN ('APPROVED', 'REJECTED'));
  END IF;
END $$;
