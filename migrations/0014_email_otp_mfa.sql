-- 0014: Email verification OTPs + MFA (TOTP) support
-- DO NOT apply to Supabase without the owner's go-ahead.

-- Email OTP table for verification codes
CREATE TABLE email_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  otp_hash text NOT NULL,
  token_hash text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_otps_email ON email_otps (email, created_at DESC);
CREATE INDEX idx_email_otps_token ON email_otps (token_hash) WHERE token_hash IS NOT NULL AND used_at IS NULL;

-- RLS (same pattern as 0010-0012: trim_api_all policy)
ALTER TABLE email_otps ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trim_api') THEN
    CREATE POLICY trim_api_all ON email_otps FOR ALL TO trim_api USING (true) WITH CHECK (true);
  END IF;
END $$;

-- MFA columns on users
ALTER TABLE users ADD COLUMN mfa_secret_encrypted text;
ALTER TABLE users ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN mfa_backup_codes_hash text[];
