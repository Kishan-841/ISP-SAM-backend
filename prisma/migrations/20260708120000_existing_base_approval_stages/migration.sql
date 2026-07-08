-- Two new org-wide roles for the internal approval chain on BASE commercial
-- changes: ACCOUNTS (final commercial sign-off) and SUPER_ADMIN_2 (first-stage
-- sign-off on disconnections).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ACCOUNTS';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN_2';

-- Account parks here while one of its BASE commercial changes walks the
-- approval chain. The change is not reflected on the account/dashboard until
-- the terminal APPROVE.
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';

-- Approval-chain status enum. Created fresh (not ALTER) so it can be used as a
-- column default in the same migration. PG < 16 has no CREATE TYPE IF NOT
-- EXISTS, so guard with a DO block to keep the migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApprovalStatus') THEN
    CREATE TYPE "ApprovalStatus" AS ENUM (
      'PENDING_SUPER_ADMIN_2',
      'PENDING_SAM_HEAD',
      'PENDING_ACCOUNTS',
      'APPROVED',
      'REJECTED',
      'NOT_REQUIRED'
    );
  END IF;
END $$;

-- Approval columns on commercial_changes. Default NOT_REQUIRED keeps every
-- existing row (and all NEW-base / backfill / bulk-import rows) valid and
-- immediately-applied.
ALTER TABLE "commercial_changes"
  ADD COLUMN IF NOT EXISTS "approval_status"  "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "rejected_by"      UUID,
  ADD COLUMN IF NOT EXISTS "rejected_at"      TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "commercial_changes_approval_status_idx"
  ON "commercial_changes"("approval_status");
