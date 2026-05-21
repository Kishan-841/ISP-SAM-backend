-- SamLeadDispatch — one row per attempt by a SAM operator to create a lead
-- via the CRM bridge. Stored on SAM side for history + audit; CRM remains
-- the system-of-record for the Lead itself.
CREATE TABLE IF NOT EXISTS "sam_lead_dispatches" (
  "id"                  uuid PRIMARY KEY,
  "sam_lead_id"         uuid NOT NULL UNIQUE,
  "company_name"        text NOT NULL,
  "contact_name"        text NOT NULL,
  "phone"               text NOT NULL,
  "email"               text,
  "designation"         text,
  "industry"            text,
  "city"                text,
  "notes"               text,
  "assigned_to_user_id" text NOT NULL,
  "assigned_to_name"    text NOT NULL,
  "assigned_to_type"    text NOT NULL,
  "crm_lead_id"         text,
  "crm_lead_number"     text,
  "status"              text NOT NULL,
  "error_reason"        text,
  "created_by"          uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at"          timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "sam_lead_dispatches_created_by_idx"
  ON "sam_lead_dispatches" ("created_by");
CREATE INDEX IF NOT EXISTS "sam_lead_dispatches_created_at_idx"
  ON "sam_lead_dispatches" ("created_at");

-- DB-level sanity checks. Status must be one of the three we recognise;
-- assigned_to_type is free-text but obvious typos are guarded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sam_lead_dispatches_status_check') THEN
    ALTER TABLE "sam_lead_dispatches"
      ADD CONSTRAINT "sam_lead_dispatches_status_check"
      CHECK ("status" IN ('SENT', 'DEDUPED', 'FAILED'));
  END IF;
END $$;
