CREATE TYPE audience AS ENUM ('all', 'men', 'women', 'kids');
CREATE TYPE style_audience AS ENUM ('men', 'women', 'unisex');
CREATE TYPE style_length AS ENUM ('short', 'medium', 'long');
CREATE TYPE maintenance_level AS ENUM ('low', 'medium', 'high');

CREATE TABLE service_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  name text NOT NULL,
  audience audience NOT NULL DEFAULT 'all',
  default_duration_min integer NOT NULL CHECK (default_duration_min BETWEEN 5 AND 480),
  suggested_price_paise integer NOT NULL CHECK (suggested_price_paise >= 0),
  sort integer NOT NULL DEFAULT 0,
  UNIQUE (category, name)
);

CREATE TABLE salon_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  template_id uuid REFERENCES service_templates(id) ON DELETE SET NULL,
  category text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text,
  audience audience NOT NULL DEFAULT 'all',
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_min integer NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  price_paise integer NOT NULL CHECK (price_paise >= 0 AND price_paise <= 10000000),
  is_active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0
);
CREATE INDEX salon_services_salon_idx ON salon_services (salon_id, is_active);

CREATE TABLE staff_services (
  staff_id uuid NOT NULL REFERENCES salon_staff(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES salon_services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE hairstyle_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  audience style_audience NOT NULL,
  face_shapes text[] NOT NULL,
  length style_length NOT NULL,
  description text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  image_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  maintenance maintenance_level NOT NULL DEFAULT 'medium',
  CHECK (face_shapes <@ ARRAY['Heart','Oblong','Oval','Round','Square']::text[])
);

CREATE TABLE hairstyle_service_map (
  hairstyle_id uuid NOT NULL REFERENCES hairstyle_catalog(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES service_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (hairstyle_id, template_id)
);
