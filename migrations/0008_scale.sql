-- Spec section 11: webhook processing becomes a job, rollups, async exports, extra indexes.

-- subscription_events: stored first, processed later by a worker (processed_at NULL = pending)
ALTER TABLE subscription_events ALTER COLUMN processed_at DROP NOT NULL;
ALTER TABLE subscription_events ALTER COLUMN processed_at DROP DEFAULT;
ALTER TABLE subscription_events ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE subscription_events ADD COLUMN result text;
ALTER TABLE subscription_events ADD COLUMN attempts integer NOT NULL DEFAULT 0;
UPDATE subscription_events SET received_at = processed_at WHERE processed_at IS NOT NULL;
CREATE INDEX subscription_events_pending_idx ON subscription_events (received_at) WHERE processed_at IS NULL;

-- hot-path indexes (the exclusion constraint already provides a GiST index on (staff_id, during))
CREATE INDEX bookings_staff_start_idx ON bookings (staff_id, starts_at);
CREATE INDEX bookings_salon_status_start_idx ON bookings (salon_id, status, starts_at);
CREATE INDEX salons_geo_idx ON salons (lat, lng) WHERE status = 'approved';
CREATE INDEX salon_staff_active_idx ON salon_staff (salon_id) WHERE is_active;
CREATE INDEX salon_services_active_cat_idx ON salon_services (salon_id, category) WHERE is_active;
CREATE INDEX reviews_public_idx ON reviews (salon_id, created_at DESC) WHERE status IN ('visible', 'reported');
CREATE INDEX sessions_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX invoices_salon_status_created_idx ON invoices (salon_id, status, created_at DESC);

-- nightly/hourly rollup so analytics do not scan raw bookings
CREATE TABLE daily_salon_stats (
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  day date NOT NULL,
  dim text NOT NULL CHECK (dim IN ('day', 'staff', 'service')),
  dim_key text NOT NULL DEFAULT '',
  bookings integer NOT NULL DEFAULT 0,
  completed integer NOT NULL DEFAULT 0,
  no_shows integer NOT NULL DEFAULT 0,
  cancelled integer NOT NULL DEFAULT 0,
  revenue_paise bigint NOT NULL DEFAULT 0,
  qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (salon_id, day, dim, dim_key)
);

-- asynchronous exports (POST .../analytics/export -> 202 {jobId})
CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'invoices_csv',
  params jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result_csv text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX export_jobs_salon_idx ON export_jobs (salon_id, created_at DESC);
