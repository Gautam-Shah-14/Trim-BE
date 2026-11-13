-- DAU/WAU/MAU: one row per user per IST day on which the user made an authenticated API request.
CREATE TABLE IF NOT EXISTS user_activity_days (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS user_activity_days_day_idx ON user_activity_days (day);

-- same lockdown as 0010 for the new table
ALTER TABLE user_activity_days ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON user_activity_days FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON user_activity_days FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trim_api') THEN
    DROP POLICY IF EXISTS trim_api_all ON user_activity_days;
    CREATE POLICY trim_api_all ON user_activity_days AS PERMISSIVE FOR ALL TO trim_api USING (true) WITH CHECK (true);
  END IF;
END
$$;
