-- Run ONLY this in Supabase SQL Editor if resume_uploads already exists
-- and you need storage_path to be nullable (so rows are inserted even when storage fails).
-- This does NOT create policies; it only alters the table. Safe to run multiple times.

ALTER TABLE public.resume_uploads ALTER COLUMN storage_path DROP NOT NULL;
