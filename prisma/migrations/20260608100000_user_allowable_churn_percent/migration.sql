-- Allowable churn budget for incentive calculation.
--   Per-SAM value, constrained to 6.00 ≤ value ≤ 8.00 in the application
--   layer (zod validation in users.controller.ts). Stored as Decimal(4,2)
--   so we have headroom for 0–99.99 if the business rule ever loosens.
--   Default of 7.00 is the midpoint of the 6–8% range — applies to every
--   existing row on backfill.
ALTER TABLE "users"
  ADD COLUMN "allowable_churn_percent" DECIMAL(4, 2) NOT NULL DEFAULT 7.00;
