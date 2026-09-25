-- Migration 008_lead_backups_channel_id.sql
-- Description: Add channel_id column to lead_backups table and create channels table

-- 1. Create channels table (if not already created manually)
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on channels table
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

-- Allow service role full access to channels
DROP POLICY IF EXISTS "service_role_channels_all" ON channels;
CREATE POLICY "service_role_channels_all" ON channels
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Add channel_id column to lead_backups if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_backups'
      AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE public.lead_backups ADD COLUMN channel_id TEXT NULL;
  END IF;
END
$$;

-- 3. Create index on channel_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_lead_backups_channel_id ON public.lead_backups(channel_id);
