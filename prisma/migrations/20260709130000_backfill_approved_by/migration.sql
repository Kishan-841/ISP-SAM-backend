-- Backfill approved_by / approved_at for BASE commercial changes that were
-- approved BEFORE those columns existed (added in 20260709120000). The
-- who + when is recoverable from the audit trail: the terminal
-- APPROVAL_APPROVED row carries performed_by (the approver) + timestamp.
-- Idempotent: only touches rows still missing approved_by. Rows with no
-- matching audit entry simply stay NULL (harmless).
UPDATE "commercial_changes" cc
SET "approved_by" = a."performed_by",
    "approved_at" = a."timestamp"
FROM "audit_logs" a
WHERE a."entity_type"    = 'CommercialChange'
  AND a."entity_id"      = cc."id"
  AND a."action"         = 'APPROVAL_APPROVED'
  AND cc."approval_status" = 'APPROVED'
  AND cc."approved_by" IS NULL;
