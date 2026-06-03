-- Allow 0 as a valid `quick_requested_days` value. Semantics:
--   0  → terminate immediately on approval (scheduledTerminationAt = approval date)
--   1..15 → existing behaviour (terminate N days after approval)
-- The original check constraint `BETWEEN 1 AND 15` rejected 0 at the DB
-- layer, which surfaced as a 500 in the commit() path even though the
-- service-level guard was already updated.
ALTER TABLE "commercial_changes"
  DROP CONSTRAINT IF EXISTS "commercial_changes_quick_requested_days_check";

ALTER TABLE "commercial_changes"
  ADD CONSTRAINT "commercial_changes_quick_requested_days_check"
  CHECK ("quick_requested_days" IS NULL OR ("quick_requested_days" BETWEEN 0 AND 15));
