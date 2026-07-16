-- Material-recovery capture for the FINAL disconnection approval (SUPER_ADMIN_2).
-- Nullable: non-disconnection rows and pre-existing decisions leave them NULL.
ALTER TABLE "commercial_changes"
  ADD COLUMN IF NOT EXISTS "material_recovered"      BOOLEAN,
  ADD COLUMN IF NOT EXISTS "material_recovery_notes" TEXT;

-- Re-seat in-flight disconnections that were queued under the OLD chain order.
--
-- Old order: SUPER_ADMIN_2 -> [SAM_HEAD] -> ACCOUNTS   (SA2 reviewed FIRST)
-- New order: [SAM_HEAD] -> ACCOUNTS -> SUPER_ADMIN_2   (SA2 is now TERMINAL)
--
-- A row sitting at PENDING_SUPER_ADMIN_2 has not been reviewed by anyone yet.
-- Left alone it would become "terminal", so SA2 approving it would finalise the
-- disconnection without ACCOUNTS ever seeing it. Move each to the new FIRST
-- stage instead: quick disconnects start at SAM_HEAD, normal ones at ACCOUNTS.
UPDATE "commercial_changes"
SET "approval_status" = CASE
      WHEN "disconnection_mode" = 'QUICK' THEN 'PENDING_SAM_HEAD'::"ApprovalStatus"
      ELSE 'PENDING_ACCOUNTS'::"ApprovalStatus"
    END
WHERE "approval_status" = 'PENDING_SUPER_ADMIN_2'
  AND "change_type" = 'DISCONNECTION';
