-- Migration 002_whatsapp_connections.sql
-- Description: Create whatsapp_connections table for single-row session storage and drop legacy multi-row table

-- 1. Create whatsapp_connections table
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_key TEXT UNIQUE NOT NULL DEFAULT 'default',
  phone_number TEXT NULL,
  jid TEXT NULL,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  encrypted_session_data TEXT NULL,
  last_connected_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index on connection_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_connections_key ON whatsapp_connections(connection_key);

-- 2. Clean up legacy multi-row whatsapp_auth_backups table
DROP TABLE IF EXISTS whatsapp_auth_backups;
