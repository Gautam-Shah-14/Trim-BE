CREATE TYPE contact_status AS ENUM ('new', 'handled');
CREATE TYPE lead_stage AS ENUM ('new', 'contacted', 'trial', 'subscribed', 'lost');

CREATE TABLE contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  salon_name text,
  message text NOT NULL,
  status contact_status NOT NULL DEFAULT 'new',
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_name text NOT NULL,
  owner_name text,
  phone text,
  email text,
  city text,
  source text,
  stage lead_stage NOT NULL DEFAULT 'new',
  owner_agent_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_agent_idx ON leads (owner_agent_id, stage);

CREATE TABLE lead_invites (
  code text PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
