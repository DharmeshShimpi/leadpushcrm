-- 003_enable_rls.sql: Enable Row Level Security (RLS) and grant full access to service_role

-- 1. Enable RLS on all public tables
ALTER TABLE public.lead_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing policies if any
DROP POLICY IF EXISTS "Allow service_role full access to lead_backups" ON public.lead_backups;
DROP POLICY IF EXISTS "Allow service_role full access to google_connections" ON public.google_connections;
DROP POLICY IF EXISTS "Allow service_role full access to whatsapp_connections" ON public.whatsapp_connections;

-- 3. Grant full CRUD access to the backend service_role
CREATE POLICY "Allow service_role full access to lead_backups"
ON public.lead_backups
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow service_role full access to google_connections"
ON public.google_connections
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow service_role full access to whatsapp_connections"
ON public.whatsapp_connections
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
