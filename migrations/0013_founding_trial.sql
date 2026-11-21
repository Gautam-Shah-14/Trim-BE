-- Phase 2: founding trial flow, cancel-flow fixes, trial-end reminders.

-- Add founding_trial flag to subscriptions so we know which salons got the founding offer
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS founding_trial boolean NOT NULL DEFAULT false;

-- Track when trial-end reminder was sent (avoid duplicates)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_reminder_sent_at timestamptz NULL;

-- same lockdown pattern
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    -- no changes needed, subscriptions already locked down
    NULL;
  END IF;
END
$$;
