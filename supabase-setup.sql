-- =============================================================================
-- ResumeToSite – Supabase setup (run in SQL Editor in your project)
-- =============================================================================
--
-- BEFORE RUNNING: Create the storage bucket in the Dashboard:
--   Storage → New bucket → Name: resume-uploads → Private → File size limit: 5MB
--
-- IF YOU ALREADY RAN THIS BEFORE: Make storage_path nullable so uploads log even when storage fails:
--   ALTER TABLE public.resume_uploads ALTER COLUMN storage_path DROP NOT NULL;
-- Then run the rest below (policies + table creation are idempotent).
--
-- =============================================================================

-- 1) Storage policies so your backend (service role) can upload and read.
--    Drop first so this script can be re-run without "policy already exists" errors.

DROP POLICY IF EXISTS "Allow uploads to resume-uploads" ON storage.objects;
CREATE POLICY "Allow uploads to resume-uploads"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = (SELECT id FROM storage.buckets WHERE name = 'resume-uploads' LIMIT 1)
);

DROP POLICY IF EXISTS "Allow read resume-uploads" ON storage.objects;
CREATE POLICY "Allow read resume-uploads"
ON storage.objects FOR SELECT
USING (
  bucket_id = (SELECT id FROM storage.buckets WHERE name = 'resume-uploads' LIMIT 1)
);

DROP POLICY IF EXISTS "Allow delete resume-uploads" ON storage.objects;
CREATE POLICY "Allow delete resume-uploads"
ON storage.objects FOR DELETE
USING (
  bucket_id = (SELECT id FROM storage.buckets WHERE name = 'resume-uploads' LIMIT 1)
);

-- =============================================================================
-- 2) Optional: table to log upload metadata (for listing / analytics later)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.resume_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path  text,
  file_name     text,
  file_size     bigint,
  template      text,
  created_at    timestamptz DEFAULT now()
);

-- If the table already existed with storage_path NOT NULL, run this once in SQL Editor:
-- ALTER TABLE public.resume_uploads ALTER COLUMN storage_path DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resume_uploads_created_at
ON public.resume_uploads (created_at DESC);

COMMENT ON TABLE public.resume_uploads IS 'Optional metadata for files stored in storage bucket resume-uploads';

-- =============================================================================
-- 3) Tracking: visitor_id + LLM responses (for search by user later)
-- =============================================================================
ALTER TABLE public.resume_uploads ADD COLUMN IF NOT EXISTS visitor_id text;
CREATE INDEX IF NOT EXISTS idx_resume_uploads_visitor_id ON public.resume_uploads (visitor_id) WHERE visitor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.generation_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_upload_id  uuid NOT NULL REFERENCES public.resume_uploads (id) ON DELETE CASCADE,
  llm_model         text NOT NULL,
  llm_html          text,
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generation_results_resume_upload_id ON public.generation_results (resume_upload_id);
CREATE INDEX IF NOT EXISTS idx_generation_results_created_at ON public.generation_results (created_at DESC);
COMMENT ON TABLE public.generation_results IS 'LLM output per generation; query by resume_upload_id or join via resume_uploads.visitor_id (later user_id)';
