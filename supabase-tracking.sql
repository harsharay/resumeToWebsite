-- =============================================================================
-- ResumeToSite – Tracking: visitor_id + LLM responses (run in Supabase SQL Editor)
-- =============================================================================
-- Use visitor_id now; add user_id later when you have auth (e.g. auth.users.id).
-- One resume_uploads row = one upload. One generation_results row = one LLM run
-- for that upload (re-generate = new row). Query by visitor_id (or later user_id).
-- =============================================================================

-- 1) Add visitor_id to resume_uploads (links upload to a visitor; later add user_id)
ALTER TABLE public.resume_uploads
  ADD COLUMN IF NOT EXISTS visitor_id text;

CREATE INDEX IF NOT EXISTS idx_resume_uploads_visitor_id
  ON public.resume_uploads (visitor_id)
  WHERE visitor_id IS NOT NULL;

COMMENT ON COLUMN public.resume_uploads.visitor_id IS 'Anonymous visitor UUID from frontend; later backfill to user_id when auth is added';

-- 2) Store each LLM response per upload (one upload can have multiple generations)
CREATE TABLE IF NOT EXISTS public.generation_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_upload_id  uuid NOT NULL REFERENCES public.resume_uploads (id) ON DELETE CASCADE,
  llm_model         text NOT NULL,
  llm_html          text,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generation_results_resume_upload_id
  ON public.generation_results (resume_upload_id);

CREATE INDEX IF NOT EXISTS idx_generation_results_created_at
  ON public.generation_results (created_at DESC);

COMMENT ON TABLE public.generation_results IS 'LLM output per generation; one row per generate click for an upload';

-- 3) Later when you add auth: uncomment and run (adjust table name if not auth.users)
-- ALTER TABLE public.resume_uploads ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users (id);
-- CREATE INDEX IF NOT EXISTS idx_resume_uploads_user_id ON public.resume_uploads (user_id);
-- Then: UPDATE resume_uploads SET user_id = <auth_id> WHERE visitor_id = <linked_visitor>;
