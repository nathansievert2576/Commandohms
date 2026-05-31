// netlify/functions/analyse.js
// Proxies requests to the Anthropic Claude API.
// JWT VALIDATION: verifies the caller holds a valid Supabase session
// before forwarding to Claude. Unauthenticated calls are rejected with 401.
// PROMPTS: built server-side from subject-specific prompt modules — never
// exposed to the client.

const https = require('https');

// ── Supabase helpers ──────────────────────────────────────────────────────────
function getSupabaseConfig() {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { supabaseUrl, supabaseKey };
}

function supabaseRequest({ supabaseUrl, supabaseKey, path, method, token, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, supabaseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': token ? `Bearer ${token}` : `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Supabase request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Returns the user object on success, null on failure.
async function validateToken(token) {
  const { supabaseUrl, supabaseKey } = getSupabaseConfig();

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return null;
  }

  try {
    const { status, body } = await supabaseRequest({
      supabaseUrl, supabaseKey,
      path: '/auth/v1/user',
      method: 'GET',
      token,
    });
    if (status === 200 && body && body.id) return body;
    console.error(`Supabase auth rejected token: status ${status}`);
    return null;
  } catch (err) {
    console.error('Supabase auth error:', err.message);
    return null;
  }
}

// Returns true if a credit was successfully spent, false if user has none.
async function spendCredit(userId) {
  const { supabaseUrl, supabaseKey } = getSupabaseConfig();
  try {
    const { status, body } = await supabaseRequest({
      supabaseUrl, supabaseKey,
      path: '/rest/v1/rpc/spend_credit',
      method: 'POST',
      body: { uid: userId },
    });
    if (status === 200 && body === true) return true;
    console.error('spend_credit returned:', status, body);
    return false;
  } catch (err) {
    console.error('spend_credit error:', err.message);
    return false;
  }
}

// ── Subject prompt loader ─────────────────────────────────────────────────────
const ALLOWED_SUBJECTS = new Set(['hms']);

function loadSubjectPrompts(subject) {
  if (!ALLOWED_SUBJECTS.has(subject)) return null;
  try {
    if (subject === 'hms') return require('./prompts/hms');
    return null;
  } catch (e) {
    console.error(`Failed to load prompts for subject "${subject}":`, e.message);
    return null;
  }
}

// ── Payload validation ────────────────────────────────────────────────────────
const MAX_TEXT_CHARS  = 60_000;
const MAX_IMAGE_BYTES = 5_242_880; // 5 MB per image (base64 decoded)
const VALID_CONTENT_TYPES = new Set(['text', 'image']);
const VALID_MEDIA_TYPES   = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_CALL_TYPES  = new Set(['annotation', 'examples', 'projectedMark', 'feedback', 'ocr']);

function validatePayload(payload) {
  const { callType, subject, promptData, messages } = payload;

  if (!callType || !ALLOWED_CALL_TYPES.has(callType)) {
    return `Invalid callType: must be one of ${[...ALLOWED_CALL_TYPES].join(', ')}`;
  }

  if (!subject || !ALLOWED_SUBJECTS.has(subject)) {
    return `Invalid subject: must be one of ${[...ALLOWED_SUBJECTS].join(', ')}`;
  }

  if (!promptData || typeof promptData !== 'object') {
    return 'promptData must be an object';
  }

  // Validate promptData fields by type — strings only, no executable content
  for (const [key, val] of Object.entries(promptData)) {
    if (val !== null && val !== undefined && typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
      return `promptData.${key} must be a string, number, or boolean`;
    }
    if (typeof val === 'string' && val.length > 50_000) {
      return `promptData.${key} exceeds maximum length`;
    }
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }

  if (messages.length > 1) {
    return 'Only one message is permitted per request';
  }

  const msg = messages[0];
  if (!msg || msg.role !== 'user') {
    return 'Message must have role "user"';
  }

  const content = Array.isArray(msg.content)
    ? msg.content
    : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : null);

  if (!content) return 'Invalid message content';

  let totalTextChars = 0;

  for (const item of content) {
    if (!item || !VALID_CONTENT_TYPES.has(item.type)) {
      return `Invalid content type: ${item && item.type}`;
    }

    if (item.type === 'text') {
      if (typeof item.text !== 'string') return 'Text content must be a string';
      totalTextChars += item.text.length;
    }

    if (item.type === 'image') {
      const src = item.source;
      if (!src || src.type !== 'base64') return 'Image source must be base64';
      if (!VALID_MEDIA_TYPES.has(src.media_type)) return `Unsupported image type: ${src.media_type}`;
      if (typeof src.data !== 'string') return 'Image data must be a string';
      const decodedBytes = Math.floor(src.data.length * 0.75);
      if (decodedBytes > MAX_IMAGE_BYTES) return 'Image exceeds 5 MB limit';
    }
  }

  if (totalTextChars > MAX_TEXT_CHARS) {
    return `Total text content exceeds ${MAX_TEXT_CHARS} character limit`;
  }

  return null; // valid
}

// ── Build system prompt ───────────────────────────────────────────────────────
function buildSystemPrompt(callType, promptData, subjectPrompts) {
  const { buildAnnotationPrompt, buildExamplePrompt, buildProjectedMarkPrompt, buildFeedbackPrompt } = subjectPrompts;

  switch (callType) {
    case 'annotation':
      return buildAnnotationPrompt(promptData);
    case 'examples':
      return buildExamplePrompt(promptData);
    case 'projectedMark':
      return buildProjectedMarkPrompt(promptData);
    case 'feedback':
      return buildFeedbackPrompt(promptData);
    case 'ocr':
      return null; // no system prompt for transcription
    default:
      return null;
  }
}

// ── Call Anthropic ────────────────────────────────────────────────────────────
async function callAnthropic(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Invalid JSON from Anthropic')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  // 1. Extract JWT
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorised: no session token. Please log in.' }) };
  }

  // 2. Validate JWT
  const user = await validateToken(token);
  if (!user) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorised: invalid or expired session. Please log in again.' }) };
  }

  // 3. Parse body
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // 5. Validate payload
  const validationError = validatePayload(payload);
  if (validationError) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: validationError }) };
  }

  // 6. Load subject prompts
  const subjectPrompts = loadSubjectPrompts(payload.subject);
  if (!subjectPrompts) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown subject: ${payload.subject}` }) };
  }

  // 7. Build system prompt server-side
  const systemPrompt = buildSystemPrompt(payload.callType, payload.promptData, subjectPrompts);

  // 8. Assemble Anthropic request — model and max_tokens set server-side
  const clean = {
    model:      'claude-sonnet-4-6',
    max_tokens: subjectPrompts.MAX_TOKENS[payload.callType],
    messages:   payload.messages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
  };

  // 9. Call Anthropic
  try {
    const { status, body } = await callAnthropic(clean);
    return { statusCode: status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  } catch (err) {
    console.error('Anthropic error:', err.message);
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Upstream API error', detail: err.message }) };
  }
};
