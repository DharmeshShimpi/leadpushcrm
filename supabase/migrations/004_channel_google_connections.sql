-- Migration 004_channel_google_connections.sql
-- Description: Add channel_id to google_connections and ensure default channel mapping
-- Note: connection_key currently stores the channel identifier (e.g. 'default')

-- 1. Add channel_id column to google_connections if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'google_connections' 
      AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE public.google_connections ADD COLUMN channel_id TEXT NULL DEFAULT 'default';
  END IF;
END $$;

-- 2. Backfill existing google_connections to assign channel_id = connection_key or 'default'
UPDATE public.google_connections 
SET channel_id = COALESCE(NULLIF(connection_key, ''), 'default')
WHERE channel_id IS NULL OR channel_id = '';

-- 3. Create index on channel_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_google_connections_channel_id ON public.google_connections(channel_id);
