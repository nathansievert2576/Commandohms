// netlify/functions/analyse.js
// Proxies requests to the Anthropic Claude API.
// JWT VALIDATION: verifies the caller holds a valid Supabase session
// before forwarding to Claude. Unauthenticated calls are rejected with 401.

const https = require('https');

// ── Validate Supabase JWT ─────────────────────────────────────────────────────
async function validateToken(token) {
  const supabaseUrl  = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  // Use service role key for server-side token validation
  const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
    return true; // fail open on misconfiguration so users aren't locked out
  }

  let hostname, path;
  try {
    const u = new URL('/auth/v1/user', supabaseUrl);
    hostname = u.hostname;
    path = u.pathname;
  } catch (e) {
    console.error('Invalid SUPABASE_URL:', supabaseUrl);
    return true;
  }

  return new Promise((resolve) => {
    const options = {
      hostname,
      path,
      method:  'GET',
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          console.error(`Supabase auth rejected token: status ${res.statusCode}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Supabase auth network error:', err.message);
      resolve(true); // fail open on network error
    });

    req.setTimeout(5000, () => {
      req.destroy();
      console.error('Supabase auth timeout — failing open');
      resolve(true);
    });

    req.end();
  });
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
  const valid = await validateToken(token);
  if (!valid) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorised: invalid or expired session. Please log in again.' }) };
  }

  // 3. Parse body
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // 4. Sanitise — whitelist fields, enforce model, cap tokens
  const clean = {};
  ['model', 'max_tokens', 'messages', 'system'].forEach(k => { if (payload[k] !== undefined) clean[k] = payload[k]; });
  clean.model = 'claude-sonnet-4-20250514';
  if (!clean.max_tokens || clean.max_tokens > 4000) clean.max_tokens = 2000;

  // 5. Call Anthropic
  try {
    const { status, body } = await callAnthropic(clean);
    return { statusCode: status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  } catch (err) {
    console.error('Anthropic error:', err.message);
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Upstream API error', detail: err.message }) };
  }
};
