-- Migration: 007_admin_username_support.sql
-- Allow phone_number to be NULL for Admin users and add unique username column

ALTER TABLE public.users ALTER COLUMN phone_number DROP NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);
