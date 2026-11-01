CREATE TYPE invoice_status AS ENUM ('draft', 'paid', 'void');
CREATE TYPE review_status AS ENUM ('visible', 'hidden', 'reported');

CREATE TABLE invoice_counters (
  salon_id uuid PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  last_no integer NOT NULL DEFAULT 0
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id),
  invoice_no text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text,
  subtotal_paise integer NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise integer NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  tax_paise integer NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise integer NOT NULL CHECK (total_paise >= 0),
  tax_label text,
  tax_rate_pct numeric(5,2),
  gstin_snapshot text,
  status invoice_status NOT NULL DEFAULT 'paid',
  voided_reason text,
  voided_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, invoice_no)
);
CREATE UNIQUE INDEX invoices_booking_uniq ON invoices (booking_id) WHERE booking_id IS NOT NULL AND status <> 'void';
CREATE INDEX invoices_salon_created_idx ON invoices (salon_id, created_at DESC);

CREATE TABLE invoice_items (
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position integer NOT NULL,
  service_id uuid REFERENCES salon_services(id) ON DELETE SET NULL,
  name text NOT NULL,
  qty integer NOT NULL CHECK (qty BETWEEN 1 AND 100),
  unit_price_paise integer NOT NULL CHECK (unit_price_paise >= 0),
  line_total_paise integer NOT NULL CHECK (line_total_paise >= 0),
  PRIMARY KEY (invoice_id, position)
);

CREATE TABLE salon_payment_methods (
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code IN ('cash', 'card', 'upi', 'wallet', 'bank_transfer', 'other')),
  label text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  upi_id text,
  sort integer NOT NULL DEFAULT 0,
  PRIMARY KEY (salon_id, code)
);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  method_code text NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise > 0),
  reference text,
  paid_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_inv_idx ON invoice_payments (invoice_id);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (char_length(comment) <= 1000),
  status review_status NOT NULL DEFAULT 'visible',
  reply_text text CHECK (char_length(reply_text) <= 1000),
  reply_by uuid REFERENCES users(id),
  reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_salon_idx ON reviews (salon_id, created_at DESC);

CREATE TABLE review_reports (
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reported_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, reported_by)
);
