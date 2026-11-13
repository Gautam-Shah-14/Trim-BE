-- Founding-salon waitlist (pre-launch). One row per e-mail (citext: case-insensitive unique).
-- TEMPORARY table: after the Play Store launch, founding entitlements (Starter plan, 2 months free from first login) are copied onto
-- the matching salons (matched_salon_id). Do NOT drop this table before that copy has been done and verified.
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_name text NOT NULL CHECK (char_length(salon_name) BETWEEN 1 AND 200),
  owner_name text NOT NULL CHECK (char_length(owner_name) BETWEEN 1 AND 200),
  email citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  phone text NULL CHECK (phone IS NULL OR phone ~ '^\+91[6-9][0-9]{9}$'),
  founding boolean NOT NULL DEFAULT true,
  consent_at timestamptz NOT NULL,
  source text NULL CHECK (source IS NULL OR char_length(source) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmation_sent_at timestamptz NULL,
  owner_copy_sent_at timestamptz NULL,
  matched_salon_id uuid NULL REFERENCES salons(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS waitlist_signups_created_idx ON waitlist_signups (created_at);

-- same lockdown as 0010/0011 for the new table
ALTER TABLE waitlist_signups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON waitlist_signups FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON waitlist_signups FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trim_api') THEN
    DROP POLICY IF EXISTS trim_api_all ON waitlist_signups;
    CREATE POLICY trim_api_all ON waitlist_signups AS PERMISSIVE FOR ALL TO trim_api USING (true) WITH CHECK (true);
  END IF;
END
$$;
