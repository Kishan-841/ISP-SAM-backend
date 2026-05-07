-- account_applied_at — set ONCE when the commercial change is mirrored onto
-- accounts.current_mrr / bandwidth / contract_status. Used as the
-- idempotency marker so refreshCrmStatus doesn't double-apply.
--
-- NULL  → change has not yet been applied to the account row
--          (typical state while CRM is processing through Docs/NOC/Accounts).
-- set   → applied; accounts.current_mrr now reflects the change's newMrr.
ALTER TABLE "commercial_changes"
  ADD COLUMN "account_applied_at" TIMESTAMPTZ(6);

CREATE INDEX "commercial_changes_account_applied_at_idx"
  ON "commercial_changes" ("account_applied_at");
