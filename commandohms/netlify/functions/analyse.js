// netlify/functions/analyse.js
// Proxies requests to the Anthropic Claude API.
// JWT VALIDATION: verifies the caller holds a valid Supabase session
// before forwarding to Claude. Unauthenticated calls are rejected with 401.

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

// ── Payload validation ────────────────────────────────────────────────────────
const MAX_TEXT_CHARS  = 60_000; // system + all text content combined
const MAX_IMAGE_BYTES = 5_242_880; // 5 MB per image (base64 decoded)
const VALID_CONTENT_TYPES = new Set(['text', 'image']);
const VALID_MEDIA_TYPES   = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function validatePayload(payload) {
  const { messages, system } = payload;

  // system must be a string if present
  if (system !== undefined && typeof system !== 'string') {
    return 'Invalid system field';
  }

  // messages must be a non-empty array
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }

  // Only allow a single user message (matches legitimate client usage)
  if (messages.length > 1) {
    return 'Only one message is permitted per request';
  }

  const msg = messages[0];
  if (!msg || msg.role !== 'user') {
    return 'Message must have role "user"';
  }

  // Normalise content to array form
  const content = Array.isArray(msg.content)
    ? msg.content
    : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : null);

  if (!content) return 'Invalid message content';

  let totalTextChars = typeof system === 'string' ? system.length : 0;

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
      // base64 encodes ~4/3 bytes — check decoded size
      const decodedBytes = Math.floor(src.data.length * 0.75);
      if (decodedBytes > MAX_IMAGE_BYTES) return 'Image exceeds 5 MB limit';
    }
  }

  if (totalTextChars > MAX_TEXT_CHARS) {
    return `Total text content exceeds ${MAX_TEXT_CHARS} character limit`;
  }

  return null; // valid
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

  // 2. Validate JWT — returns user object or null
  const user = await validateToken(token);
  if (!user) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorised: invalid or expired session. Please log in again.' }) };
  }

  // 3. Server-side credit check — deduct before calling Anthropic
  const credited = await spendCredit(user.id);
  if (!credited) {
    return { statusCode: 402, headers: cors, body: JSON.stringify({ error: 'No credits remaining. Please purchase more to continue.' }) };
  }

  // 4. Parse body
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // 5. Validate and sanitise payload
  const validationError = validatePayload(payload);
  if (validationError) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: validationError }) };
  }

  const clean = {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: payload.messages,
    ...(payload.system ? { system: payload.system } : {}),
  };

  // 6. Call Anthropic
  try {
    const { status, body } = await callAnthropic(clean);
    return { statusCode: status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  } catch (err) {
    console.error('Anthropic error:', err.message);
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Upstream API error', detail: err.message }) };
  }
};
