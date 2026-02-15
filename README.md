# ResumeToSite

Turn a resume (PDF, DOCX, or TXT) into a full HTML portfolio website using AI. The frontend lets users upload a file or paste text, pick a template, and stream the generated HTML into a live preview. The backend handles file storage (Supabase), text extraction, cleaning, LLM calls (Gemini or Anthropic), and saves every upload and LLM response for tracking (and future auth).

---

## Table of contents

- [High-level flow](#high-level-flow)
- [Backend (Node/Express)](#backend-nodeexpress)
- [Frontend (index.html)](#frontend-indexhtml)
- [Environment variables](#environment-variables)
- [Supabase (DB + Storage)](#supabase-db--storage)
- [Deployment](#deployment)

---

## High-level flow

1. **User** opens the app → sees **Home** (hero + “How it works”) or goes to **Create Website** (upload + preview).
2. **User** uploads a resume (or pastes text), chooses a template, clicks **Generate**.
3. **Frontend** sends `POST /api/generate/upload-stream` with `FormData`: `resume`, `template`, `visitor_id`.
4. **Backend**:
   - Saves the file to Supabase Storage (if configured).
   - Inserts a row into `resume_uploads` (with `visitor_id`).
   - Extracts text from the file (PDF/DOCX/TXT).
   - Cleans the text (trim, collapse newlines, cap length).
   - Calls Gemini (streaming), writes HTML chunks as **Server-Sent Events (SSE)** to the response.
   - When the stream finishes, inserts a row into `generation_results` (LLM HTML for that upload).
5. **Frontend** reads the SSE stream, appends chunks to HTML, updates the preview iframe every 200ms, then shows a success message and keeps the full HTML for **Download** / **Refresh** / **Open in new tab**.

---

## Backend (Node/Express)

Entry point: **`server.js`**. It sets up Express, CORS, rate limit, body parsing, file upload, serves the API under `/api/generate`, and serves the static frontend (including `index.html` at `/`).

### server.js – what runs

| Piece | Purpose |
|-------|--------|
| `dotenv.config()` | Loads `.env` (PORT, API keys, Supabase, etc.). |
| `helmet()` | Security headers (CSP disabled so the preview iframe can load generated HTML). |
| `cors()` | Allows origins like `localhost:3000`, `127.0.0.1:5500` (Live Server), etc. |
| `rateLimit` on `/api/` | 10 requests per 15 minutes per IP. |
| `express.json()` / `urlencoded()` | Parse JSON and form bodies (10MB limit). |
| `fileUpload()` | Handles `multipart/form-data`: puts the file in `req.files.resume`, uses `os.tmpdir()` for temp files (works on Windows). |
| `morgan` | HTTP request logging. |
| `GET /health` | Returns `{ status, timestamp, uptime }` for health checks. |
| `app.use('/api/generate', generateRoutes)` | All generate API routes (see below). |
| `express.static(__dirname)` + `GET /` | Serves `index.html` and other static files from the project root. |
| Error + 404 handlers | Return JSON error payloads. |
| `app.listen(PORT)` | Starts the HTTP server (default 3000). |

---

### routes/generate.js – API and helpers

This file defines the **generate** router and all logic for upload, storage, text extraction, cleaning, LLM (non-stream + stream), and tracking.

#### Configuration (env)

- **Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`), `SUPABASE_BUCKET` (default `resume-uploads`).
- **LLM:** `GEMINI_API_KEY` (preferred) or `LLM_API_KEY` / `ANTHROPIC_API_KEY`.

Supabase client is only created if URL and key look valid (no placeholders). Same for logging when Supabase is disabled.

#### Functions (in order of use in the flow)

- **`storeFileInSupabase(file, buffer)`**  
  - If Supabase is not configured, returns `null`.  
  - Builds a unique filename (`timestamp-originalname`), uploads `buffer` to the bucket.  
  - If the bucket is missing, tries to create it (private, 5MB limit, allowed MIME types), then retries the upload.  
  - Returns the storage path (or `null` on failure). Used to record that a file was stored.

- **`logResumeUpload(storagePath, fileName, fileSize, template, visitorId)`**  
  - Inserts one row into **`resume_uploads`**: `storage_path`, `file_name`, `file_size`, `template`, `visitor_id`.  
  - Returns the new row **`id`** (or `null`). That id is used later to link the LLM result.

- **`saveGenerationResult(resumeUploadId, llmModel, llmHtml)`**  
  - Inserts one row into **`generation_results`**: `resume_upload_id`, `llm_model`, `llm_html`.  
  - Called after the LLM returns (or after the stream finishes) so every generation is stored for the upload.

- **`extractTextFromFile(bufferOrPath, mimetype, originalName)`**  
  - **TXT:** reads buffer as UTF-8 string.  
  - **PDF:** uses `pdf-parse` on a copy of the buffer; temporarily suppresses “TT: undefined function” warnings; throws a friendly error if the PDF is unreadable.  
  - **DOCX:** uses `mammoth.extractRawText({ buffer })`.  
  - Returns the raw text string; throws if type is unsupported or a required library is missing.

- **`cleanResumeData(rawText)`**  
  - Normalizes line endings, collapses spaces, trims.  
  - Collapses many newlines to at most two.  
  - Truncates to 15,000 characters to keep the LLM payload small.  
  - Returns the cleaned string.

- **`generateHtmlWithLLM(cleanedText, template)`**  
  - Builds a system + user prompt (template name is included).  
  - If **`GEMINI_API_KEY`** is set → calls **`generateWithGemini`** (single non-stream request).  
  - Else if **`LLM_API_KEY`** is set → calls **`generateWithAnthropic`**.  
  - Otherwise returns a placeholder HTML page telling the user to set a key.  
  - Return value is a single HTML string.

- **`generateWithGemini(systemPrompt, userMessage)`**  
  - Uses `@google/genai` (dynamic `import`).  
  - Calls `ai.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt, config: { maxOutputTokens: 8192 } })`.  
  - Reads `response.text` or falls back to `response.candidates[0].content.parts[0].text`.  
  - Strips markdown code fences from the result and returns the HTML string.  
  - On 401 / invalid key, throws a clear error.

- **`generateWithAnthropic(systemPrompt, userMessage)`**  
  - Uses `@anthropic-ai/sdk`, `client.messages.create` with system + user message.  
  - Returns the first message’s text, with markdown fences stripped.

- **`escapeHtml(s)`**  
  - Escapes `&`, `<`, `>`, `"` for safe HTML/attribute use (e.g. placeholder page).

- **`streamWithGemini(cleanedText, template, res, resumeUploadId)`**  
  - Sets **SSE** headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.  
  - Builds the same prompt as the non-stream path, then calls **`ai.models.generateContentStream`**.  
  - For each chunk: reads `chunk.text` (or nested candidates/parts), appends to `fullHtml`, and writes `data: {"chunk":"..."}\n\n` to `res`.  
  - When the stream ends: trims markdown from `fullHtml`, then calls **`saveGenerationResult(resumeUploadId, 'gemini-2.0-flash', cleanedHtml)`** if `resumeUploadId` is set.  
  - Sends `data: {"done":true}\n\n` and ends the response.  
  - On error, sends `data: {"error":"..."}\n\n`.

#### Routes

- **`POST /api/generate/upload`** (non-stream)  
  1. Checks `req.files.resume` and reads file into a buffer (from temp file or `file.data`).  
  2. Reads `template` and `visitor_id` from `req.body`.  
  3. Calls `storeFileInSupabase`, then `logResumeUpload(..., visitorId)` and gets `resumeUploadId`.  
  4. `extractTextFromFile` → `cleanResumeData` → `generateHtmlWithLLM`.  
  5. Calls `saveGenerationResult(resumeUploadId, 'gemini-2.0-flash', html)`.  
  6. Responds with `{ data: { html }, storedPath? }`.

- **`POST /api/generate/upload-stream`** (streaming, used by the app)  
  1. Same validation and buffer reading; reads `template` and `visitor_id`.  
  2. Optional: `storeFileInSupabase` and `logResumeUpload(..., visitorId)` → `resumeUploadId`.  
  3. `extractTextFromFile` → `cleanResumeData`.  
  4. Calls **`streamWithGemini(cleanedText, template, res, resumeUploadId)`**, which streams SSE and saves the full HTML to `generation_results` when done.  
  5. No JSON response; the body is the SSE stream.

So: **upload** = store file + log upload + extract + clean + one-shot LLM + save result + JSON. **upload-stream** = same up to clean, then stream LLM output over SSE and save the full HTML at the end.

---

## Frontend (index.html)

Single-page app: **Home** (landing) and **App** (upload + preview). No build step; one HTML file with inline CSS and script.

### Constants and state

- **`API_URL`** – Base URL for the API (e.g. `http://localhost:3000/api/generate`). Must match the backend and deployment.
- **`VISITOR_STORAGE_KEY`** – `localStorage` key for the anonymous visitor id.
- **`selectedFile`** – The current file (File object) or null.
- **`generatedHTML`** – Last generated full HTML string (used for preview, download, open in new tab).
- **`selectedTemplate`** – One of: `modern`, `creative`, `professional`, `tech`, `minimal`.

### Functions (logical order)

- **`getVisitorId()`**  
  - Reads `resumetosite_visitor_id` from `localStorage`.  
  - If missing or too short, generates `v_` + `crypto.randomUUID()` (or a fallback id), saves it, returns it.  
  - Used so every generate request is tied to the same anonymous user for backend tracking.

- **`showAppView()`**  
  - Hides the home section, shows the app section, sets the header to “← Back to Home”.

- **`showHomeView()`**  
  - Hides the app section, shows the home section, restores the “Create Website” button and wires its click to `showAppView`.

- **`handleFileSelect(e)`**  
  - Called when the file input changes; passes the first file to `handleFile`.

- **`handleFile(file)`**  
  - Validates type (PDF, DOCX, TXT) and size (≤ 5MB).  
  - Sets `selectedFile`, calls `displayFileInfo(file)`, enables the Generate button, hides any previous error.

- **`displayFileInfo(file)`**  
  - Sets the file name and size in the UI and shows the file-info block.

- **`formatFileSize(bytes)`**  
  - Returns a string like `"380.4 KB"` or `"1.2 MB"`.

- **`removeFile()`**  
  - Clears `selectedFile`, resets the file input, hides file info, disables Generate.

- **Template options**  
  - Click handlers on `.template-option`: set `selectedTemplate` to the option’s `data-template` and update the selected styling.

- **`openTextModal()`** / **`closeTextModal()`**  
  - Show/hide the “Paste your resume” modal.

- **`submitText()`**  
  - Reads the textarea, creates a `File` with that text as `resume.txt`, passes it to `handleFile`, then closes the modal.

- **`showPreview(html)`**  
  - Sets the iframe’s `srcdoc` to `html`, shows the iframe, hides the placeholder. Used both during streaming (partial HTML) and at the end (full HTML).

- **`setPlaceholderText(title, sub)`**  
  - Sets the placeholder title and subtitle (e.g. “Streaming your website...”, “Your website preview will appear here”).

- **`generateWebsite()`** (main flow)  
  1. If no `selectedFile`, shows error and returns.  
  2. Shows loading overlay, hides errors, sets placeholder to “Streaming...”, hides iframe, clears `generatedHTML`.  
  3. Builds **FormData**: `resume`, `template`, `visitor_id` (from `getVisitorId()`).  
  4. **Fetch** `POST ${API_URL}/upload-stream` with that body.  
  5. If not `response.ok`, parses error JSON and throws.  
  6. Uses **`response.body.getReader()`** and **`TextDecoder`** to read the stream.  
  7. Buffers incoming text, splits by newlines, and for each line starting with `data: ` parses JSON:  
     - `obj.error` → throw.  
     - `obj.chunk` → append to `html`, and every 200ms call `showPreview(html)`.  
     - `obj.done` → trim markdown from `html`, set `generatedHTML`, call `showPreview(generatedHTML)`, hide loading, show success, reset placeholder, return.  
  8. After the loop, processes any remaining buffer (last incomplete line) for a final `chunk`/`done`.  
  9. If no `done` was seen in the buffer, does a final trim and sets `generatedHTML`; then shows preview and success or “No HTML received”.  
  10. On any error, shows error (and hint for API failures), resets placeholder; `finally` always hides the loading overlay.

- **`refreshPreview()`**  
  - If `generatedHTML` exists, sets the iframe’s `srcdoc` to it again (e.g. after a glitch).

- **`openInNewTab()`**  
  - Creates a blob URL from `generatedHTML` and opens it in a new tab.

- **`downloadHTML()`**  
  - Creates a blob, temporary `<a download="my-portfolio.html">`, triggers click, revokes the URL, shows success.

- **`showError(message, fromApi)`**  
  - Shows the error alert (message escaped with `escapeHtml`). If `fromApi`, shows the hint with “Paste Text” and hides it after 8s.

- **`escapeHtml(s)`**  
  - Uses a temporary div’s `textContent` and `innerHTML` to escape user/server text for safe display.

- **`hideError()`**  
  - Hides the error alert and hint.

- **`showSuccess(message)`**  
  - Shows the success alert and auto-hides it after 5s.

### How the frontend and backend work together

- User actions (upload, paste, template, Generate) only change local state and call the **upload-stream** endpoint with FormData.
- The backend does not send cookies or auth; it only uses `visitor_id` from the body for tracking.
- The only “API contract” is: **SSE stream** of `data: {"chunk":"..."}` and finally `data: {"done":true}` (or `data: {"error":"..."}`). The frontend never parses a single JSON body for the stream; it only parses line-by-line SSE events.

---

## Environment variables

Create a **`.env`** in the project root (same folder as `server.js`). Example:

```env
PORT=3000
NODE_ENV=development

# LLM – one of these (Gemini recommended)
GEMINI_API_KEY=your_gemini_key_from_aistudio_google_com
# LLM_API_KEY=sk-ant-...   # optional, Anthropic

# Supabase – for storage + tables (resume_uploads, generation_results)
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
SUPABASE_BUCKET=resume-uploads

# Optional: restrict CORS (comma-separated)
# ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

- **Backend** reads these; frontend only needs the correct **`API_URL`** in `index.html` (or from a config) so it hits your deployed API.

---

## Supabase (DB + Storage)

### Storage

- **Bucket:** `resume-uploads` (or the name in `SUPABASE_BUCKET`).  
- Created automatically by the backend if it doesn’t exist (private, 5MB limit, allowed MIME types for PDF/DOCX/TXT).  
- Each uploaded file is stored with a name like `timestamp-originalname`.

### Tables

- **`resume_uploads`**  
  - One row per upload: `id`, `storage_path`, `file_name`, `file_size`, `template`, `visitor_id`, `created_at`.  
  - Used for tracking and, later, “list my uploads” by `visitor_id` or `user_id`.

- **`generation_results`**  
  - One row per LLM run: `id`, `resume_upload_id` (FK to `resume_uploads`), `llm_model`, `llm_html`, `created_at`.  
  - Stores the exact HTML returned for that upload so you can search by visitor/user and show history.

SQL to create/alter these (and indexes) is in **`supabase-setup.sql`** and **`supabase-tracking.sql`**. Run them in the Supabase SQL Editor if you haven’t already.

---

## Deployment

### Can you use one Vercel “container” for both?

- **Frontend:** Yes. It’s static (one HTML file, no build). You can deploy it as a static site on Vercel.
- **Backend:** It’s a **long-running Node server** (Express, file upload, **streaming SSE**, temp files). Vercel’s model is **serverless functions**: short, stateless requests. So:
  - **As-is:** The current backend is **not** a good fit for a single Vercel “container” that runs the Express server. You’d have to rewrite the backend into Vercel serverless functions (and handle multipart upload, streaming, and possibly body size limits).
  - **Recommended:** Run **frontend and backend separately**: frontend on Vercel (or any static host), backend on a Node host that supports streaming and file upload.

### Option A – Frontend and backend separate (recommended)

1. **Backend (Node)**  
   Deploy the same repo (or just `server.js` + `routes/` + `package.json` + `.env`) to a service that runs Node and supports streaming:
   - **Railway** – connect GitHub, set root to the project, add env vars, deploy.
   - **Render** – “Web Service”, Node, `npm install` + `npm start`, add env vars.
   - **Fly.io** – Docker or direct Node; run `node server.js` (or your start script).

   Set **`PORT`** to what the platform gives (e.g. `process.env.PORT`). Add your production origins to **`ALLOWED_ORIGINS`** in `.env` (e.g. your Vercel URL).

2. **Frontend (static)**  
   - **Vercel:** New project from same repo (or a folder with only `index.html`). Set **Build** to “None” or a trivial build; **Output** = static.  
   - In **`index.html`**, set **`API_URL`** to your backend base URL, e.g. `https://your-backend.railway.app/api/generate` (no trailing slash).  
   - Add that Vercel URL to the backend’s **`ALLOWED_ORIGINS`** so CORS allows it.

Result: users open the Vercel URL; the page calls your Node API for upload-stream; backend uses Supabase and Gemini as today.

### Option B – All on one Node host (simplest)

Deploy the **whole project** (including `index.html`) to **Railway**, **Render**, or **Fly.io**:

- Run `npm install` and `npm start`.
- The same server serves both the API and `index.html` at `/`.
- Set **`API_URL`** in `index.html` to the same host, e.g. `https://your-app.railway.app/api/generate`, or use a relative path like `/api/generate` so it works for any domain.

No CORS issues for the same origin; one deployment and one URL.

### Option C – Vercel for both (advanced)

You’d need to:

- Turn the **backend** into **Vercel serverless functions** (e.g. one function for `upload-stream` that reads multipart body, calls Gemini stream, returns SSE).  
- Respect Vercel’s request/response limits (e.g. body size, execution time).  
- Deploy the **frontend** as static on the same Vercel project.

This is more work and may require changes to how the stream is produced (e.g. buffering and streaming within Vercel’s response model). So it’s only worth it if you specifically want everything on Vercel.

---

## Quick reference

| What | Where |
|------|--------|
| API base | `server.js` → `/api/generate` (routes in `routes/generate.js`) |
| Stream endpoint | `POST /api/generate/upload-stream` (FormData: `resume`, `template`, `visitor_id`) |
| Non-stream endpoint | `POST /api/generate/upload` (same body; returns JSON `{ data: { html } }`) |
| Frontend entry | `index.html` at `/` (or open the file directly during dev) |
| Visitor id | Frontend: `getVisitorId()` → localStorage; backend: `req.body.visitor_id` |
| Upload tracking | `resume_uploads` (per upload) + `generation_results` (per LLM run) |
| Env keys | `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`; optional `LLM_API_KEY`, `ALLOWED_ORIGINS` |

If you want, the next step can be a short “Deploy to Railway + Vercel” checklist (exact env vars and `API_URL` for your repo).
