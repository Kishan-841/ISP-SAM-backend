-- Backfill `start_of_period_arc` for accounts that came in via the CRM
-- webhook before that field was being captured. Without this, dashboards
-- treat current_arc as the starting value, so post-onboarding commercial
-- changes don't show up as a delta.
--
-- Strategy:
--  1. For accounts that have at least one commercial_changes row, use the
--     oldest change's `old_arc` — that's the value BEFORE the very first
--     change happened, i.e. the activation-time ARC.
--  2. For accounts with no commercial_changes rows, the current value IS
--     the starting value (nothing has changed since onboarding) — copy
--     current_arc.
--
-- Idempotent: only updates rows where start_of_period_arc IS NULL.

WITH first_change AS (
  SELECT DISTINCT ON ("account_id") "account_id", "old_arc"
  FROM "commercial_changes"
  ORDER BY "account_id", "effective_date" ASC, "created_at" ASC
)
UPDATE "accounts" a
SET "start_of_period_arc" = COALESCE(
  (SELECT fc."old_arc" FROM first_change fc WHERE fc."account_id" = a."id"),
  a."current_arc"
)
WHERE a."start_of_period_arc" IS NULL;
