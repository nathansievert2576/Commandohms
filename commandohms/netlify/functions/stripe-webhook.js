// netlify/functions/webhook.js
//
// Handles Stripe webhook events and credits the correct CommandoHSC account.
//
// Email resolution priority (most → least reliable):
//   1. session.metadata.commandohsc_email  — set by create-checkout-session.js
//   2. session.customer_details.email       — filled by Stripe from payment method
//   3. session.customer_email               — pre-filled at session creation (fallback)
//
// Required environment variables:
//   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET    — whsec_...  from Stripe dashboard → Webhooks
//   SUPABASE_URL             — https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY     — service_role key (NOT the anon key — needs write access)

const https = require('https');
const crypto = require('crypto');

// ── Stripe webhook signature verification ─────────────────────────────────────
function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts.t;
  const signatures = sigHeader
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));

  if (!timestamp || signatures.length === 0) return false;

  // Reject events older than 5 minutes to prevent replay attacks
  const tolerance = 5 * 60;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > tolerance) {
    console.error('[webhook] Timestamp too old — possible replay attack');
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

// ── Supabase RPC helper ───────────────────────────────────────────────────────
function supabaseRequest(method, path, body, serviceKey, supabaseHost) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: supabaseHost,
        path,
        method,
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Add credits to a user account ─────────────────────────────────────────────
// Uses an RPC function in Supabase to atomically increment credits.
// The SQL function should be: 
//   create or replace function add_credits(user_email text, amount int)
//   returns void language plpgsql as $$
//   begin
//     update profiles set credits = credits + amount where email = user_email;
//   end; $$;
async function addCredits(email, credits, stripeSessionId) {
  const supabaseUrl   = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }

  const supabaseHost = new URL(supabaseUrl).hostname;

  // ── Guard: check for duplicate webhook delivery ──────────────────────────
  // Look for an existing payment record with this Stripe session ID.
  const checkPath = `/rest/v1/payments?stripe_session_id=eq.${encodeURIComponent(stripeSessionId)}&select=id`;
  const check = await supabaseRequest('GET', checkPath, null, serviceKey, supabaseHost);
  if (check.status === 200) {
    const existing = JSON.parse(check.body);
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`[webhook] Duplicate event for session ${stripeSessionId} — skipping`);
      return 'duplicate';
    }
  }

  // ── Credit the account ───────────────────────────────────────────────────
  const rpcPath = '/rest/v1/rpc/add_credits';
  const rpcResult = await supabaseRequest(
    'POST',
    rpcPath,
    { user_email: email, amount: credits },
    serviceKey,
    supabaseHost
  );

  if (rpcResult.status !== 200 && rpcResult.status !== 204) {
    // User not found or RPC error — record as pending for manual review
    await supabaseRequest(
      'POST',
      '/rest/v1/payments',
      {
        stripe_session_id: stripeSessionId,
        email,
        credits,
        status: 'pending',
        created_at: new Date().toISOString(),
      },
      serviceKey,
      supabaseHost
    );
    console.error(`[webhook] add_credits RPC failed (${rpcResult.status}) for ${email} — recorded as pending`);
    return 'pending';
  }

  // ── Record successful payment ────────────────────────────────────────────
  await supabaseRequest(
    'POST',
    '/rest/v1/payments',
    {
      stripe_session_id: stripeSessionId,
      email,
      credits,
      status: 'completed',
      created_at: new Date().toISOString(),
    },
    serviceKey,
    supabaseHost
  );

  console.log(`[webhook] ✓ Credited ${credits} credits to ${email} (session ${stripeSessionId})`);
  return 'completed';
}

// ── Lambda handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // ── 1. Verify Stripe signature ──────────────────────────────────────────────
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET not set');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }

  const sigHeader = event.headers['stripe-signature'];
  if (!sigHeader) {
    return { statusCode: 400, body: 'Missing Stripe signature' };
  }

  const rawBody = event.body;
  if (!verifyStripeSignature(rawBody, sigHeader, webhookSecret)) {
    console.error('[webhook] Signature verification failed');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  // ── 2. Parse event ──────────────────────────────────────────────────────────
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // ── 3. Handle checkout.session.completed ───────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // Email resolution — priority order:
    //   1. metadata.commandohsc_email (injected by create-checkout-session.js)
    //   2. customer_details.email (provided by Stripe from payment method)
    //   3. customer_email (pre-filled at session creation)
    const email =
      session.metadata?.commandohsc_email ||
      session.customer_details?.email ||
      session.customer_email ||
      null;

    // Credits resolution — from metadata (set at session creation) or
    // fall back to a lookup by tier label if metadata is missing.
    const creditsRaw = session.metadata?.credits;
    const credits = creditsRaw ? parseInt(creditsRaw, 10) : null;

    if (!email) {
      console.error('[webhook] No email found on session:', session.id);
      return { statusCode: 200, body: 'No email — skipped' };
    }

    if (!credits || isNaN(credits)) {
      console.error('[webhook] No credits metadata on session:', session.id);
      return { statusCode: 200, body: 'No credits metadata — skipped' };
    }

    const result = await addCredits(email, credits, session.id);
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, result, email, credits }),
    };
  }

  // Acknowledge all other event types
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
