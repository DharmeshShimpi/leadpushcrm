-- Migration 005_channel_whatsapp_connections.sql
-- Description: Add channel_id to whatsapp_connections table and ensure default channel mapping

-- 1. Add channel_id column to whatsapp_connections if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'whatsapp_connections' 
      AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE public.whatsapp_connections ADD COLUMN channel_id TEXT NULL DEFAULT 'default';
  END IF;
END $$;

-- 2. Backfill existing whatsapp_connections to assign channel_id = connection_key or 'default'
UPDATE public.whatsapp_connections 
SET channel_id = COALESCE(NULLIF(connection_key, ''), 'default')
WHERE channel_id IS NULL OR channel_id = '';

-- 3. Create index on channel_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_channel_id ON public.whatsapp_connections(channel_id);
