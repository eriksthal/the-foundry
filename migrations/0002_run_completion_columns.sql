-- T012 run completion schema additions
-- Adds nullable columns used by run finalization and task failure reporting.

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE runs
ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
