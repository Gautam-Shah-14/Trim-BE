CREATE TYPE platform_role AS ENUM ('customer', 'salon_user', 'admin', 'sales_agent');
CREATE TYPE media_kind AS ENUM ('logo', 'salon_photo', 'avatar', 'staff_photo');

CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid,
  salon_id uuid,
  kind media_kind NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 204800),
  data_base64 text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_salon_idx ON media (salon_id, kind);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email citext UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  platform_role platform_role NOT NULL DEFAULT 'customer',
  avatar_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_contact_present CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX users_role_idx ON users (platform_role);

ALTER TABLE media ADD CONSTRAINT media_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  device_label text,
  client text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE device_tokens (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text NOT NULL DEFAULT 'android',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  endpoint text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key, endpoint)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid,
  salon_id uuid,
  action text NOT NULL,
  entity text,
  entity_id text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_salon_idx ON audit_log (salon_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);
