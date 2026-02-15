// routes/generate.js - Upload, store, clean, LLM, return HTML
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

// ---------------------------------------------------------------------------
// PLACEHOLDER: Supabase project details (set in .env or replace below)
// ---------------------------------------------------------------------------
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim() || 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim() || 'YOUR_SUPABASE_SERVICE_ROLE_KEY';
const SUPABASE_BUCKET = (process.env.SUPABASE_BUCKET || 'resume-uploads').trim();

// ---------------------------------------------------------------------------
// LLM API keys (set in .env - never commit real keys). Trim to avoid 401.
// Use GEMINI_API_KEY for Google Gemini, or LLM_API_KEY/ANTHROPIC_API_KEY for Anthropic.
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const LLM_API_KEY = (process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || 'YOUR_LLM_API_KEY_HERE').trim();

// Supabase: only init when URL and key look real (no placeholders)
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const urlOk = SUPABASE_URL && SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR_PROJECT');
  const keyOk = SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.length > 20 && !SUPABASE_SERVICE_KEY.includes('YOUR_');
  if (urlOk && keyOk) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log('[ResumeToSite] Supabase initialized. URL:', SUPABASE_URL.replace(/\/\/.*@/, '//***@'), 'bucket:', SUPABASE_BUCKET);
  } else {
    const why = [];
    if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_PROJECT')) why.push('SUPABASE_URL missing or placeholder');
    else if (!SUPABASE_URL.startsWith('https://')) why.push('SUPABASE_URL must start with https://');
    if (!SUPABASE_SERVICE_KEY || SUPABASE_SERVICE_KEY.includes('YOUR_')) why.push('SUPABASE_SERVICE_KEY missing or placeholder');
    else if (SUPABASE_SERVICE_KEY.length <= 20) why.push('SUPABASE_SERVICE_KEY too short');
    console.log('[ResumeToSite] Supabase disabled:', why.join('; '), '→ Add both to .env and restart. Service key: Project Settings → API → service_role (secret).');
  }
} catch (e) {
  console.warn('[ResumeToSite] Supabase init failed:', e.message);
}

// PDF text extraction (optional dependency)
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {}

// DOCX text extraction (optional dependency)
let mammoth = null;
try {
  mammoth = require('mammoth');
} catch (e) {}

/**
 * Store file in Supabase Storage and optionally log to resume_uploads table.
 */
async function storeFileInSupabase(file, buffer) {
  if (!supabase) {
    console.log('[ResumeToSite] storeFileInSupabase: skipped (no supabase client)');
    return null;
  }
  const fileName = `${Date.now()}-${(file.name || 'resume').replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  console.log('[ResumeToSite] Storage upload starting, bucket=', SUPABASE_BUCKET, 'fileName=', fileName);
  let result = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(fileName, buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false });
  if (result.error && result.error.message && result.error.message.toLowerCase().includes('bucket not found')) {
    console.log('[ResumeToSite] Bucket missing, creating', SUPABASE_BUCKET, '...');
    const { error: createErr } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false,
      fileSizeLimit: 5242880,
      allowedMimeTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
    });
    if (createErr) {
      console.warn('[ResumeToSite] Bucket create failed:', createErr.message, '→ Create bucket in Dashboard → Storage → New bucket.');
    } else {
      result = await supabase.storage.from(SUPABASE_BUCKET).upload(fileName, buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false });
    }
  }
  if (result.error) {
    console.warn('[ResumeToSite] Storage upload failed:', result.error.message);
    return null;
  }
  const storagePath = result.data?.path || fileName;
  console.log('[ResumeToSite] Storage upload OK, path=', storagePath);
  return storagePath;
}

/** Insert a row into public.resume_uploads; returns the new row id or null. */
async function logResumeUpload(storagePath, fileName, fileSize, template, visitorId) {
  if (!supabase) {
    console.log('[ResumeToSite] logResumeUpload: skipped (no supabase client)');
    return null;
  }
  const row = {
    storage_path: storagePath || null,
    file_name: fileName || null,
    file_size: fileSize != null ? Number(fileSize) : null,
    template: template || null,
    visitor_id: visitorId || null,
  };
  console.log('[ResumeToSite] resume_uploads insert attempting, visitor_id=', visitorId ? visitorId.slice(0, 8) + '...' : 'none');
  const { data, error } = await supabase.from('resume_uploads').insert(row).select('id').single();
  if (error) {
    console.error('[ResumeToSite] resume_uploads insert FAILED:', error.code, error.message);
    return null;
  }
  const id = data?.id || null;
  if (id) console.log('[ResumeToSite] resume_uploads insert OK, id=', id);
  return id;
}

/** Save LLM response for an upload (for tracking and future search by visitor/user). */
async function saveGenerationResult(resumeUploadId, llmModel, llmHtml) {
  if (!supabase || !resumeUploadId) return;
  const row = {
    resume_upload_id: resumeUploadId,
    llm_model: llmModel || 'gemini-2.0-flash',
    llm_html: llmHtml || null,
  };
  const { error } = await supabase.from('generation_results').insert(row).select('id');
  if (error) {
    console.warn('[ResumeToSite] generation_results insert failed:', error.message);
    return;
  }
  console.log('[ResumeToSite] generation_results saved for upload', resumeUploadId);
}

/**
 * Extract plain text from uploaded file (PDF, DOCX, TXT).
 * Accepts buffer (for PDF/DOCX) or filePath (for reading from disk).
 */
async function extractTextFromFile(bufferOrPath, mimetype, originalName) {
  const isBuffer = Buffer.isBuffer(bufferOrPath);
  const ext = (originalName && path.extname(originalName).toLowerCase()) || '';
  const isTxt = mimetype === 'text/plain' || ext === '.txt';
  const isPdf = mimetype === 'application/pdf' || ext === '.pdf';
  const isDocx = mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx';

  if (isTxt) {
    const buf = isBuffer ? bufferOrPath : await fs.readFile(bufferOrPath);
    return buf.toString('utf8');
  }

  if (isPdf && pdfParse) {
    const buf = isBuffer ? bufferOrPath : await fs.readFile(bufferOrPath);
    if (!buf || buf.length < 100) {
      throw new Error('PDF file is too small or empty. Please upload a valid PDF.');
    }
    try {
      const origWarn = console.warn;
      console.warn = (...args) => {
        const msg = args[0] != null ? String(args[0]) : '';
        if (msg.includes('TT: undefined function') || msg.includes('undefined function:')) return;
        origWarn.apply(console, args);
      };
      try {
        const data = await pdfParse(Buffer.from(buf));
        return data.text || '';
      } finally {
        console.warn = origWarn;
      }
    } catch (e) {
      throw new Error(e.message && e.message.includes('stream') ? 'Could not read PDF (file may be corrupted or password-protected). Try re-saving the PDF or use Paste Text.' : (e.message || 'PDF parsing failed.'));
    }
  }

  if (isDocx && mammoth) {
    const buf = isBuffer ? bufferOrPath : await fs.readFile(bufferOrPath);
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value || '';
  }

  if (isPdf || isDocx) {
    throw new Error(
      isPdf
        ? 'PDF parsing requires: npm install pdf-parse'
        : 'DOCX parsing requires: npm install mammoth'
    );
  }

  throw new Error('Unsupported file type. Use PDF, DOCX, or TXT.');
}

/**
 * Clean and minimize resume text before sending to LLM:
 * - Trim and normalize whitespace
 * - Collapse multiple newlines
 * - Optionally cap length to reduce tokens
 */
function cleanResumeData(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let t = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Collapse multiple newlines to max 2
  t = t.replace(/\n{3,}/g, '\n\n');
  // Max length to avoid huge payloads (e.g. ~20k chars ≈ ~5k tokens)
  const maxLen = 15000;
  if (t.length > maxLen) {
    t = t.slice(0, maxLen) + '\n\n[... content truncated for length ...]';
  }
  return t;
}

/**
 * Call LLM to generate HTML from cleaned resume text and template.
 * Uses Gemini when GEMINI_API_KEY is set, otherwise Anthropic when LLM_API_KEY is set.
 */
async function generateHtmlWithLLM(cleanedText, template) {
  const systemPrompt = `You are a web designer. Given resume text, output a single complete HTML document (no markdown, no code fences). Style: ${template}. Modern, responsive, bold design. Include all resume info. Return only the HTML.`;
  const userMessage = `Resume content:\n\n${cleanedText}`;

  // Prefer Gemini if key is set
  if (GEMINI_API_KEY) {
    // console.log('Generating with Gemini', GEMINI_API_KEY);
    return generateWithGemini(systemPrompt, userMessage);
  }
  if (LLM_API_KEY && LLM_API_KEY !== 'YOUR_LLM_API_KEY_HERE') {
    return generateWithAnthropic(systemPrompt, userMessage);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resume Site</title></head><body><h1>ResumeToSite</h1><p>Set GEMINI_API_KEY or LLM_API_KEY in .env to generate real content. Get Gemini key at <a href="https://aistudio.google.com/apikey">aistudio.google.com/apikey</a>.</p><pre>${escapeHtml(cleanedText.slice(0, 500))}</pre></body></html>`;
}

async function generateWithGemini(systemPrompt, userMessage) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const prompt = `${systemPrompt}\n\n${userMessage}`;
  console.log('[ResumeToSite] Gemini request: model=gemini-2.0-flash, prompt length=', prompt.length);
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: { maxOutputTokens: 8192 },
    });
    let html = '';
    if (response && typeof response.text === 'string') {
      html = response.text;
    } else if (response && response.candidates && response.candidates[0]) {
      const c = response.candidates[0];
      const content = c.content || c.output;
      if (content && content.parts && content.parts[0]) {
        html = content.parts[0].text || '';
      }
    }
    html = (html || '').replace(/^```html?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    if (!html) {
      console.warn('[ResumeToSite] Gemini returned empty or unexpected shape. response keys=', response ? Object.keys(response) : 'null');
    }
    return html || '<!DOCTYPE html><html><body><p>No content returned from Gemini.</p></body></html>';
  } catch (e) {
    console.error('[ResumeToSite] Gemini error:', e.message, e.status || '', e.code || '');
    const msg = (e && e.message) ? e.message.toLowerCase() : '';
    if (e.status === 401 || msg.includes('api key') || msg.includes('invalid') || msg.includes('authentication')) {
      throw new Error('Invalid Gemini API key. In .env set GEMINI_API_KEY to your key from https://aistudio.google.com/apikey (no quotes or spaces).');
    }
    throw e;
  }
}

async function generateWithAnthropic(systemPrompt, userMessage) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: LLM_API_KEY });
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    let html = message.content && message.content[0] && message.content[0].text ? message.content[0].text : '';
    html = html.replace(/^```html?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    return html || '<!DOCTYPE html><html><body><p>No content returned from LLM.</p></body></html>';
  } catch (e) {
    if (e.status === 401 || (e.error && e.error.message && e.error.message.toLowerCase().includes('invalid x-api-key'))) {
      throw new Error('Invalid Anthropic API key. In .env set LLM_API_KEY or ANTHROPIC_API_KEY to your key from https://console.anthropic.com/ (no quotes or spaces).');
    }
    throw e;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Stream Gemini HTML to response as SSE; optionally save full HTML to generation_results when done. */
async function streamWithGemini(cleanedText, template, res, resumeUploadId) {
  if (!GEMINI_API_KEY) {
    res.write('data: ' + JSON.stringify({ error: 'Streaming requires GEMINI_API_KEY in .env' }) + '\n\n');
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const systemPrompt = `You are a web designer. Given resume text, output a single complete HTML document (no markdown, no code fences). Style: ${template}. Modern, responsive, bold design. Include all resume info. Return only the HTML.`;
  const userMessage = `Resume content:\n\n${cleanedText}`;
  const prompt = `${systemPrompt}\n\n${userMessage}`;

  let chunkCount = 0;
  let fullHtml = '';
  try {
    const stream = await ai.models.generateContentStream({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: { maxOutputTokens: 8192 },
    });
    for await (const chunk of stream) {
      let text = (chunk && typeof chunk.text === 'string') ? chunk.text : '';
      if (!text && chunk) {
        text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
          || chunk?.response?.candidates?.[0]?.content?.parts?.[0]?.text
          || (chunk.parts && chunk.parts[0]?.text) || '';
      }
      if (text) {
        chunkCount++;
        fullHtml += text;
        res.write('data: ' + JSON.stringify({ chunk: text }) + '\n\n');
        if (typeof res.flush === 'function') res.flush();
      }
    }
    if (chunkCount === 0) console.warn('[ResumeToSite] Stream finished but no chunks had text.');
    const cleanedHtml = (fullHtml || '').replace(/^```html?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    if (resumeUploadId && cleanedHtml) await saveGenerationResult(resumeUploadId, 'gemini-2.0-flash', cleanedHtml);
    res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
  } catch (e) {
    console.error('[ResumeToSite] Stream error:', e.message);
    res.write('data: ' + JSON.stringify({ error: e.message || 'Stream failed' }) + '\n\n');
  }
  res.end();
}

// POST /api/generate/upload - single endpoint: upload → store → clean → LLM → return HTML
router.post('/upload', async (req, res) => {
  try {
    if (!req.files || !req.files.resume) {
      return res.status(400).json({
        error: { message: 'No resume file uploaded. Use field name "resume".' },
      });
    }

    const file = req.files.resume;
    const template = (req.body && req.body.template) || 'modern';
    const visitorId = (req.body && req.body.visitor_id) ? String(req.body.visitor_id).trim() : null;

    // When useTempFiles is true, file.data is often empty; always read from temp file when present
    let buffer;
    if (file.tempFilePath) {
      buffer = await fs.readFile(file.tempFilePath);
    } else if (Buffer.isBuffer(file.data) && file.data.length > 0) {
      buffer = file.data;
    } else {
      return res.status(400).json({
        error: { message: 'Uploaded file has no data. Please try again or use a different file.' },
      });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        error: { message: 'File is empty. Please upload a valid resume file.' },
      });
    }

    // 1) Store in Supabase Storage (if configured), then log every upload to resume_uploads
    console.log('[ResumeToSite] Upload request: file=', file.name, 'size=', buffer.length, 'supabase=', !!supabase);
    const storedPath = await storeFileInSupabase(file, buffer);
    console.log('[ResumeToSite] After storage: storedPath=', storedPath);
    let resumeUploadId = null;
    if (supabase) {
      resumeUploadId = await logResumeUpload(storedPath, file.name || 'resume', buffer.length, template, visitorId);
    }

    // 2) Extract text from file (pass a copy for pdf-parse to avoid stream issues)
    const rawText = await extractTextFromFile(Buffer.from(buffer), file.mimetype, file.name);
    console.log('[ResumeToSite] Extracted raw text length=', rawText ? rawText.length : 0);

    // 3) Clean and minimize data before sending to LLM
    const cleanedText = cleanResumeData(rawText);
    if (!cleanedText) {
      return res.status(400).json({
        error: { message: 'Could not extract text from the file. Try a different file or paste text.' },
      });
    }
    console.log('[ResumeToSite] Cleaned text length=', cleanedText.length, 'template=', template);

    // 4) Generate HTML via LLM (placeholder key supported)
    console.log('[ResumeToSite] Calling LLM (Gemini)...');
    const html = await generateHtmlWithLLM(cleanedText, template);
    console.log('[ResumeToSite] LLM returned HTML length=', html ? html.length : 0, 'startsWith <!DOCTYPE=', html ? html.trimStart().startsWith('<!DOCTYPE') : false);

    if (resumeUploadId && html) await saveGenerationResult(resumeUploadId, 'gemini-2.0-flash', html);

    // 5) Respond with HTML for frontend to preview/render
    res.status(200).json({
      data: { html },
      ...(storedPath && { storedPath }),
    });
  } catch (err) {
    console.error('Generate upload error:', err);
    const status = err.status || 500;
    let message = err.message || 'Failed to generate website';
    if (status === 401) {
      message = 'Invalid API key. If using Gemini set GEMINI_API_KEY in .env (from https://aistudio.google.com/apikey). If using Anthropic set LLM_API_KEY (from https://console.anthropic.com/). No quotes or spaces.';
    }
    res.status(status).json({
      error: { message },
    });
  }
});

// POST /api/generate/upload-stream - same as upload but streams HTML via SSE (Gemini only)
router.post('/upload-stream', async (req, res) => {
  try {
    if (!req.files || !req.files.resume) {
      return res.status(400).json({ error: { message: 'No resume file uploaded. Use field name "resume".' } });
    }
    const file = req.files.resume;
    const template = (req.body && req.body.template) || 'modern';
    const visitorId = (req.body && req.body.visitor_id) ? String(req.body.visitor_id).trim() : null;
    let buffer;
    if (file.tempFilePath) {
      buffer = await fs.readFile(file.tempFilePath);
    } else if (Buffer.isBuffer(file.data) && file.data.length > 0) {
      buffer = file.data;
    } else {
      return res.status(400).json({ error: { message: 'Uploaded file has no data.' } });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: { message: 'File is empty.' } });
    }
    let resumeUploadId = null;
    if (supabase) {
      const storedPath = await storeFileInSupabase(file, buffer);
      resumeUploadId = await logResumeUpload(storedPath, file.name || 'resume', buffer.length, template, visitorId);
    }
    const rawText = await extractTextFromFile(Buffer.from(buffer), file.mimetype, file.name);
    const cleanedText = cleanResumeData(rawText);
    if (!cleanedText) {
      return res.status(400).json({ error: { message: 'Could not extract text from the file.' } });
    }
    console.log('[ResumeToSite] Stream starting, cleaned length=', cleanedText.length);
    await streamWithGemini(cleanedText, template, res, resumeUploadId);
  } catch (err) {
    console.error('[ResumeToSite] Upload-stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Stream failed' } });
    }
  }
});

module.exports = router;
