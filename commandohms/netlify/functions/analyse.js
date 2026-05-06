// netlify/functions/analyse.js
// Proxies requests to the Anthropic Claude API.
// JWT VALIDATION: verifies the caller holds a valid Supabase session
// before forwarding to Claude. Unauthenticated calls are rejected with 401.

const https = require('https');

// ── JWT validation against Supabase ──────────────────────────────────────────
// Calls Supabase's /auth/v1/user endpoint with the bearer token.
// Returns the user object if valid, throws if not.
async function validateSupabaseJWT(token) {
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseAnon = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnon) {
    throw new Error('Server misconfiguration: SUPABASE_URL or SUPABASE_ANON_KEY missing');
  }

  const url = new URL('/auth/v1/user', supabaseUrl);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: {
        'apikey':        supabaseAnon,
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Invalid JSON from Supabase auth'));
          }
        } else {
          reject(new Error(`Supabase auth returned ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Supabase auth timeout')); });
    req.end();
  });
}

// ── Anthropic API call ────────────────────────────────────────────────────────
async function callAnthropic(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Server misconfiguration: ANTHROPIC_API_KEY missing');

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
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error('Invalid JSON from Anthropic'));
        }
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
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── 1. Extract and validate JWT ──────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unauthorised: no token provided' }),
    };
  }

  try {
    await validateSupabaseJWT(token);
    // Token is valid — user is authenticated. Proceed.
  } catch (err) {
    console.error('JWT validation failed:', err.message);
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unauthorised: invalid or expired session' }),
    };
  }

  // ── 2. Parse request body ────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // Whitelist allowed fields — never forward unknown fields
  const allowed = ['model', 'max_tokens', 'messages', 'system'];
  const cleanPayload = {};
  allowed.forEach(k => { if (payload[k] !== undefined) cleanPayload[k] = payload[k]; });

  // Enforce model — never allow caller to override to a different model
  cleanPayload.model = 'claude-sonnet-4-20250514';

  // Cap max_tokens at a safe ceiling
  if (!cleanPayload.max_tokens || cleanPayload.max_tokens > 4000) {
    cleanPayload.max_tokens = 2000;
  }

  // ── 3. Call Anthropic ────────────────────────────────────────────────────
  try {
    const { status, body } = await callAnthropic(cleanPayload);
    return {
      statusCode: status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Upstream API error', detail: err.message }),
    };
  }
};
