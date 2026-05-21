// netlify/functions/redeem-promo.js
//
// Validates and redeems a promo code, crediting the user's account.
// Calls the redeem_promo_code(p_code, p_user_id) Supabase RPC which handles
// validation, deduplication, and credit addition atomically.
//
// Required env vars (Netlify dashboard):
//   SUPABASE_URL              — https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service_role key (server-side only, never expose to client)

const https = require('https');

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Returns the full Supabase user object { id, email, ... } or null
async function getUser(token) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceKey) return null;

  const u = new URL('/auth/v1/user', supabaseUrl);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'GET',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        } else { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Calls a Supabase RPC and returns { status, data }
function callRpc(rpcName, params) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const u = new URL(`/rest/v1/rpc/${rpcName}`, supabaseUrl);
  const body = JSON.stringify(params);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers: {
        apikey:           serviceKey,
        Authorization:    `Bearer ${serviceKey}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Supabase RPC timeout')); });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Auth
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  const user = await getUser(token);
  if (!user?.id) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }

  // 2. Parse code from request body
  let code;
  try {
    const payload = JSON.parse(event.body || '{}');
    code = (payload.code || '').trim().toUpperCase();
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!code) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No code provided' }) };
  }

  // 3. Redeem via atomic Supabase RPC
  let result;
  try {
    result = await callRpc('redeem_promo_code', { p_code: code, p_user_id: user.id });
  } catch (err) {
    console.error('[redeem-promo] RPC error:', err.message);
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Server error — please try again' }) };
  }

  if (result.status !== 200) {
    console.error('[redeem-promo] RPC returned status', result.status, result.data);
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Server error — please try again' }) };
  }

  const rpcResult = result.data;
  if (rpcResult?.error) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: rpcResult.error }) };
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, credits_granted: rpcResult.credits_granted }),
  };
};
