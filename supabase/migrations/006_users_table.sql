-- Migration 006_users_table.sql
-- Description: Create users table for Admin + Operator authentication MVP
-- Target: leadpush-dev ONLY

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone_number TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  channel_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast login lookup by phone_number
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);

-- Index for channel-based operator queries
CREATE INDEX IF NOT EXISTS idx_users_channel_id ON users(channel_id);

-- Index for role-based queries
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
