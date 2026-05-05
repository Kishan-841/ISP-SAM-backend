-- Service-order linkage on commercial_changes + atomic enum rename.
-- Uses ALTER TYPE ... RENAME VALUE (Postgres 10+) so existing rows with
-- changeType=TERMINATION transparently become DISCONNECTION — no data loss.

-- 1. Rename the enum value in place. Atomic, no rewrite of existing rows.
ALTER TYPE "CommercialChangeType" RENAME VALUE 'TERMINATION' TO 'DISCONNECTION';

-- 2. CRM service-order linkage.
ALTER TABLE "commercial_changes"
  ADD COLUMN "crm_service_order_id" TEXT,
  ADD COLUMN "crm_order_number" TEXT,
  ADD COLUMN "crm_status" TEXT,
  ADD COLUMN "crm_status_updated_at" TIMESTAMPTZ(6),
  ADD COLUMN "activation_date" DATE;

-- 3. Disconnection-specific fields (only populated when changeType=DISCONNECTION).
ALTER TABLE "commercial_changes"
  ADD COLUMN "disconnection_category_id" TEXT,
  ADD COLUMN "disconnection_sub_category_id" TEXT,
  ADD COLUMN "disconnection_reason" TEXT;

-- 4. Indexes & uniques.
CREATE UNIQUE INDEX "commercial_changes_crm_service_order_id_key"
  ON "commercial_changes" ("crm_service_order_id");

CREATE UNIQUE INDEX "commercial_changes_crm_order_number_key"
  ON "commercial_changes" ("crm_order_number");

CREATE INDEX "commercial_changes_crm_status_idx"
  ON "commercial_changes" ("crm_status");
