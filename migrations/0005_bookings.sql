CREATE TYPE booking_source AS ENUM ('app', 'walk_in');
CREATE TYPE booking_status AS ENUM ('held', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'expired');

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  staff_id uuid NOT NULL REFERENCES salon_staff(id),
  source booking_source NOT NULL DEFAULT 'app',
  status booking_status NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  during tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  total_duration_min integer NOT NULL CHECK (total_duration_min > 0),
  total_price_paise integer NOT NULL CHECK (total_price_paise >= 0),
  hold_expires_at timestamptz,
  qr_nonce text,
  version integer NOT NULL DEFAULT 0,
  cancelled_reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (staff_id WITH =, during WITH &&)
    WHERE (status IN ('held', 'confirmed', 'checked_in'))
);
CREATE UNIQUE INDEX bookings_customer_idem_idx ON bookings (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX bookings_salon_start_idx ON bookings (salon_id, starts_at);
CREATE INDEX bookings_customer_idx ON bookings (customer_id, starts_at DESC);
CREATE INDEX bookings_hold_idx ON bookings (hold_expires_at) WHERE status = 'held';

CREATE TABLE booking_items (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id uuid REFERENCES salon_services(id) ON DELETE SET NULL,
  name_snapshot text NOT NULL,
  duration_min integer NOT NULL,
  price_paise_snapshot integer NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (booking_id, position)
);
