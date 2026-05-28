-- Add seven first-class business / compliance / segmentation fields to
-- `accounts` so the Excel importer can capture columns previously dropped
-- into the `metadata` JSON blob. None are unique-constrained — a customer
-- group can share a GST, an internal slug can change, etc.
ALTER TABLE "accounts"
  ADD COLUMN "gst_number"          TEXT,
  ADD COLUMN "contact_person_name" TEXT,
  ADD COLUMN "industry_type"       TEXT,
  ADD COLUMN "circle"              TEXT,
  ADD COLUMN "account_manager"     TEXT,
  ADD COLUMN "user_name"           TEXT,
  ADD COLUMN "ip_details"          TEXT;
