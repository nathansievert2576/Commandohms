// netlify/functions/create-checkout-session.js
//
// Creates a Stripe Checkout Session on demand, injecting the logged-in
// user's CommandoHSC account email as session metadata so the webhook
// can reliably credit the correct account regardless of payment method
// (card, Klarna, Afterpay, Apple Pay, etc.).
//
// Required environment variables (set in Netlify dashboard):
//   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
//   SUPABASE_URL           — https://xxxx.supabase.co
//   SUPABASE_ANON_KEY      — your Supabase anon/public key
//   APP_URL                — https://app.commandohsc.com  (no trailing slash)

const https = require('https');

// ── CORS headers ──────────────────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Credit tier config ────────────────────────────────────────────────────────
// Keep prices in sync with your Stripe dashboard and the HTML buy buttons.
const TIERS = {
  starter:  { credits: 10,  amount_aud_cents: 399,  label: 'Starter – 10 credits'  },
  standard: { credits: 30,  amount_aud_cents: 999,  label: 'Standard – 30 credits' },
  intensive: { credits: 60,  amount_aud_cents: 1499, label: 'Intensive – 60 credits' },
};

// ── Validate Supabase JWT ────────────────────────────────────────────────────
async function validateToken(token) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';

  if (!supabaseUrl || !supabaseKey) {
    console.error('[checkout] Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return null; // fail closed
  }

  let hostname, path;
  try {
    const u = new URL('/auth/v1/user', supabaseUrl);
    hostname = u.hostname;
    path = u.pathname;
  } catch {
    console.error('[checkout] Invalid SUPABASE_URL');
    return null;
  }

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'GET',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const user = JSON.parse(body);
              resolve(user.email || null);
            } catch {
              resolve(null);
            }
          } else {
            console.error(`[checkout] Supabase auth ${res.statusCode}`);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (err) => {
      console.error('[checkout] Supabase request error:', err.message);
      resolve(null);
    });
    req.end();
  });
}

// ── Generic HTTPS POST helper ─────────────────────────────────────────────────
function httpsPost(hostname, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Stripe form-encode helper ─────────────────────────────────────────────────
function encodeForm(obj, prefix) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') {
      parts.push(encodeForm(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

// ── Create Stripe Checkout Session ───────────────────────────────────────────
async function createCheckoutSession(tier, accountEmail) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY not set');

  const { credits, amount_aud_cents, label } = TIERS[tier];
  const appUrl = (process.env.APP_URL || 'https://app.commandohsc.com').replace(/\/$/, '');

  const params = {
    mode: 'payment',
    'payment_method_types[]': 'card',
    // Add 'klarna', 'afterpay_clearpay' here once enabled in your Stripe dashboard:
    // 'payment_method_types[1]': 'klarna',
    // 'payment_method_types[2]': 'afterpay_clearpay',
    'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][unit_amount]': String(amount_aud_cents),
    'line_items[0][price_data][product_data][name]': label,
    'line_items[0][quantity]': '1',
    // Pre-fill the email field in Checkout — reduces friction & mismatches
    customer_email: accountEmail,
    // Metadata travels with the session regardless of payment method used
    'metadata[commandohsc_email]': accountEmail,
    'metadata[credits]': String(credits),
    'metadata[tier]': tier,
    success_url: `${appUrl}?payment=success&tier=${tier}`,
    cancel_url:  `${appUrl}?payment=cancelled`,
  };

  const body = encodeForm(params);
  const { status, body: responseBody } = await httpsPost(
    'api.stripe.com',
    '/v1/checkout/sessions',
    {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body
  );

  const session = JSON.parse(responseBody);
  if (status !== 200) {
    throw new Error(session?.error?.message || `Stripe error ${status}`);
  }
  return session;
}

// ── Lambda handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── 1. Authenticate the caller ──────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No auth token provided' }),
    };
  }

  const accountEmail = await validateToken(token);
  if (!accountEmail) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid or expired session' }),
    };
  }

  // ── 2. Parse and validate the tier ─────────────────────────────────────────
  let tier;
  try {
    const payload = JSON.parse(event.body || '{}');
    tier = payload.tier;
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  if (!TIERS[tier]) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Unknown tier: ${tier}. Must be starter, standard, or value.` }),
    };
  }

  // ── 3. Create the Checkout Session ─────────────────────────────────────────
  try {
    const session = await createCheckoutSession(tier, accountEmail);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('[checkout] Stripe error:', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Could not create checkout session', detail: err.message }),
    };
  }
};
