-- Migration 001_phase5_tables.sql
-- Description: Create lead_backups and google_connections tables for Phase 5

-- 1. Create lead_backups table
CREATE TABLE IF NOT EXISTS lead_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_identity TEXT UNIQUE NOT NULL,
  whatsapp_jid TEXT NOT NULL,
  whatsapp_phone TEXT NULL,
  customer_name TEXT NULL,
  status TEXT NOT NULL,
  latest_message TEXT NULL,
  first_activity_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  qualification_reason TEXT NULL,
  confidence NUMERIC NULL,
  conversation_summary TEXT NULL,
  extracted_answers JSONB NULL,
  google_sheet_row_number INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup by lead_identity
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_backups_lead_identity ON lead_backups(lead_identity);

-- 2. Create google_connections table
CREATE TABLE IF NOT EXISTS google_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_key TEXT UNIQUE NOT NULL,
  encrypted_refresh_token TEXT NULL,
  google_email TEXT NULL,
  spreadsheet_id TEXT NULL,
  spreadsheet_name TEXT NULL,
  sheet_tab_name TEXT NULL,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for connection_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_connections_key ON google_connections(connection_key);
