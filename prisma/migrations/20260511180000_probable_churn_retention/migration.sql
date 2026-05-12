-- 21-day probable-churn retention workflow for disconnections.
--
-- On commit, a DISCONNECTION moves the account into PROBABLE_CHURN
-- (not TERMINATED). 21 days later the SAM is prompted to either
-- RETAIN (back to ACTIVE) or PROCEED (move to DISCONNECTING + schedule
-- termination 10 days out). The account is fully terminated on
-- `scheduled_termination_at`.

-- New ContractStatus values: PROBABLE_CHURN, DISCONNECTING.
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'PROBABLE_CHURN';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'DISCONNECTING';

-- New RetentionDecision enum used on the commercial_changes row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RetentionDecision') THEN
    CREATE TYPE "RetentionDecision" AS ENUM ('RETAIN', 'PROCEED');
  END IF;
END
$$;

ALTER TABLE "commercial_changes"
  ADD COLUMN IF NOT EXISTS "retention_prompt_due_at"   DATE,
  ADD COLUMN IF NOT EXISTS "retention_decision"        "RetentionDecision",
  ADD COLUMN IF NOT EXISTS "retention_decided_at"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "scheduled_termination_at"  DATE;

-- Index used by the lazy-termination sweep + day-21 prompt surfaces.
CREATE INDEX IF NOT EXISTS "commercial_changes_retention_prompt_due_at_idx"
  ON "commercial_changes" ("retention_prompt_due_at")
  WHERE "retention_prompt_due_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "commercial_changes_scheduled_termination_at_idx"
  ON "commercial_changes" ("scheduled_termination_at")
  WHERE "scheduled_termination_at" IS NOT NULL;
