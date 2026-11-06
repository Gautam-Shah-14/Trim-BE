-- Defence in depth for hosted Postgres (Supabase exposes the public schema through PostgREST with the anon/authenticated roles).
-- Trim never uses that API: only this server connects, as the table owner (which bypasses RLS). Locking everything down means a
-- leaked anon key cannot read or write any table. Idempotent. Identical to what was applied by hand on the remote project.
-- If the DML-only login role trim_api exists (the hosted deployment's API role) it gets one permissive policy per table, so RLS never blocks the API.
-- NOTE: tables created by LATER migrations must also run `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and, when trim_api exists, create the
-- trim_api_all policy (copy the loop below into the migration; see docs/KT_Guide.md).

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trim_api') THEN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('DROP POLICY IF EXISTS trim_api_all ON public.%I', t.tablename);
      EXECUTE format('CREATE POLICY trim_api_all ON public.%I AS PERMISSIVE FOR ALL TO trim_api USING (true) WITH CHECK (true)', t.tablename);
    END LOOP;
  END IF;

  -- the roles only exist on Supabase; plain Postgres (tests, Render) has nothing to revoke
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;
  END IF;
END
$$;
