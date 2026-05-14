-- Date SAM received the customer's email approving the commercial change.
-- Nullable: legacy commercial_changes rows pre-date the field, and the form
-- enforces "required" rather than the column.
ALTER TABLE "commercial_changes"
  ADD COLUMN IF NOT EXISTS "mail_received_date" DATE;
