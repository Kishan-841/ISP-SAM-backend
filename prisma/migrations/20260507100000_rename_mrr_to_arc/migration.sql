-- Rename MRR columns to ARC and convert stored monthly values to annual.
-- Before: accounts.current_mrr held a monthly figure; the SAM platform
--         multiplied by 12 everywhere it displayed/forwarded an annual.
-- After:  the columns hold the annual figure directly. Every consumer
--         drops its × 12 / ÷ 12 fudge and the float-precision class of
--         bugs (e.g. 8333 × 12 = 99,996 vs ₹1L) is gone.

-- accounts.current_mrr → current_arc
ALTER TABLE "accounts" RENAME COLUMN "current_mrr" TO "current_arc";
UPDATE "accounts" SET "current_arc" = "current_arc" * 12;

-- accounts.start_of_period_mrr → start_of_period_arc
ALTER TABLE "accounts" RENAME COLUMN "start_of_period_mrr" TO "start_of_period_arc";
UPDATE "accounts" SET "start_of_period_arc" = "start_of_period_arc" * 12 WHERE "start_of_period_arc" IS NOT NULL;

-- commercial_changes.old_mrr / new_mrr → old_arc / new_arc
ALTER TABLE "commercial_changes" RENAME COLUMN "old_mrr" TO "old_arc";
UPDATE "commercial_changes" SET "old_arc" = "old_arc" * 12;

ALTER TABLE "commercial_changes" RENAME COLUMN "new_mrr" TO "new_arc";
UPDATE "commercial_changes" SET "new_arc" = "new_arc" * 12;

-- Drop an unused/orphan index left over from the add_account_applied_at
-- migration. It was never declared in schema.prisma; Prisma flags it as drift
-- on every migrate dev. No code queries by accountAppliedAt — clean it up here.
DROP INDEX IF EXISTS "commercial_changes_account_applied_at_idx";
