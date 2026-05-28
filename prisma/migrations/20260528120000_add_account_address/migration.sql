-- Add a free-form `address` column to accounts. Populated by the Excel
-- importer and shown on the customer detail page. Kept as plain TEXT
-- (single textarea on the UI) — no structured parsing yet.
ALTER TABLE "accounts" ADD COLUMN "address" TEXT;
