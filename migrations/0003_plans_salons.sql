CREATE TYPE analytics_level AS ENUM ('basic', 'full');
CREATE TYPE salon_status AS ENUM ('pending', 'approved', 'suspended');
CREATE TYPE sub_interval AS ENUM ('monthly', 'annual');
CREATE TYPE sub_status AS ENUM ('trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired');

CREATE TABLE plans (
  code text PRIMARY KEY CHECK (code IN ('starter', 'pro')),
  name text NOT NULL,
  price_monthly_paise integer NOT NULL CHECK (price_monthly_paise >= 0),
  price_annual_paise integer NOT NULL CHECK (price_annual_paise >= 0),
  razorpay_plan_id_monthly text,
  razorpay_plan_id_annual text,
  max_branches integer,
  max_staff integer,
  custom_roles boolean NOT NULL DEFAULT false,
  desktop_access boolean NOT NULL DEFAULT false,
  analytics_level analytics_level NOT NULL DEFAULT 'basic',
  csv_export boolean NOT NULL DEFAULT false,
  bill_templates boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reference data the API cannot run without. Admins may edit prices/limits later.
INSERT INTO plans (code, name, price_monthly_paise, price_annual_paise, max_branches, max_staff, custom_roles, desktop_access, analytics_level, csv_export, bill_templates)
VALUES
  ('starter', 'Starter', 59900, 599900, 1, 3, false, false, 'basic', false, false),
  ('pro', 'Pro', 129900, 1299900, 3, NULL, true, true, 'full', true, true);

CREATE TABLE salons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE,
  description text,
  phone text,
  address_line text,
  city text,
  state text,
  pincode text,
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  logo_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  brand_color text,
  bill_footer text,
  gstin text,
  gst_enabled boolean NOT NULL DEFAULT false,
  invoice_prefix text NOT NULL DEFAULT 'INV',
  cancel_cutoff_min integer NOT NULL DEFAULT 120 CHECK (cancel_cutoff_min >= 0),
  rating_avg numeric(3,2) NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  status salon_status NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX salons_status_idx ON salons (status);
CREATE INDEX salons_city_idx ON salons (lower(city));

CREATE TABLE salon_hours (
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens time NOT NULL,
  closes time NOT NULL,
  is_closed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (salon_id, weekday),
  CHECK (is_closed OR opens < closes)
);

CREATE TABLE salon_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  date date NOT NULL,
  reason text,
  UNIQUE (salon_id, date)
);

CREATE TABLE salon_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  is_system boolean NOT NULL DEFAULT false,
  UNIQUE (salon_id, name)
);

CREATE TABLE salon_role_permissions (
  role_id uuid NOT NULL REFERENCES salon_roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE salon_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES salon_roles(id),
  display_name text NOT NULL,
  photo_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  speed_multiplier numeric(3,2) NOT NULL DEFAULT 1.0 CHECK (speed_multiplier BETWEEN 0.5 AND 2.0),
  is_bookable boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, user_id)
);
CREATE INDEX salon_staff_user_idx ON salon_staff (user_id);

CREATE TABLE staff_hours (
  staff_id uuid NOT NULL REFERENCES salon_staff(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  PRIMARY KEY (staff_id, weekday),
  CHECK (start_time < end_time)
);

CREATE TABLE staff_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES salon_staff(id) ON DELETE CASCADE,
  during tstzrange NOT NULL CHECK (NOT isempty(during)),
  reason text
);
CREATE INDEX staff_time_off_idx ON staff_time_off USING gist (staff_id, during);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL UNIQUE REFERENCES salons(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES plans(code),
  interval sub_interval NOT NULL DEFAULT 'monthly',
  status sub_status NOT NULL DEFAULT 'trialing',
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  comp_until timestamptz,
  razorpay_subscription_id text UNIQUE,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  past_due_since timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_events (
  id bigserial PRIMARY KEY,
  razorpay_event_id text NOT NULL UNIQUE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE receipt_seq START 1;

CREATE TABLE subscription_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  razorpay_payment_id text NOT NULL UNIQUE,
  amount_paise integer NOT NULL CHECK (amount_paise >= 0),
  period_start timestamptz,
  period_end timestamptz,
  receipt_no text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_salon_idx ON subscription_receipts (salon_id, issued_at DESC);
