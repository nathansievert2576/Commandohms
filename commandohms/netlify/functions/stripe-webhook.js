// netlify/functions/webhook.js
//
// Handles Stripe webhook events, credits the correct CommandoHSC account,
// and pays referral rewards (10 credits) on a referred user's first purchase.

const https = require('https');
const crypto = require('crypto');

function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const signatures = sigHeader.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return signatures.some((sig) => {
    try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); }
    catch { return false; }
  });
}

function supabaseRequest(method, path, body, serviceKey, supabaseHost) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: supabaseHost, path, method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function addCredits(email, credits, stripeSessionId) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  const supabaseHost = new URL(supabaseUrl).hostname;

  // Duplicate guard
  const check = await supabaseRequest('GET', `/rest/v1/payments?stripe_session_id=eq.${encodeURIComponent(stripeSessionId)}&select=id`, null, serviceKey, supabaseHost);
  if (check.status === 200) {
    const existing = JSON.parse(check.body);
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`[webhook] Duplicate event for session ${stripeSessionId} — skipping`);
      return { result: 'duplicate', userUid: null };
    }
  }

  // Look up user UUID from email
  const uidResult = await supabaseRequest('POST', '/rest/v1/rpc/get_user_id_by_email', { user_email: email }, serviceKey, supabaseHost);
  if (uidResult.status !== 200) {
    await supabaseRequest('POST', '/rest/v1/payments', { stripe_session_id: stripeSessionId, email, credits, status: 'pending', created_at: new Date().toISOString() }, serviceKey, supabaseHost);
    console.error(`[webhook] get_user_id_by_email failed (${uidResult.status}) for ${email}`);
    return { result: 'pending', userUid: null };
  }

  const userUid = JSON.parse(uidResult.body);
  if (!userUid) {
    await supabaseRequest('POST', '/rest/v1/payments', { stripe_session_id: stripeSessionId, email, credits, status: 'pending', created_at: new Date().toISOString() }, serviceKey, supabaseHost);
    console.error(`[webhook] No user found for email ${email}`);
    return { result: 'pending', userUid: null };
  }

  // Credit the account
  const rpcResult = await supabaseRequest('POST', '/rest/v1/rpc/add_credits', { uid: userUid, amount: credits }, serviceKey, supabaseHost);
  if (rpcResult.status !== 200 && rpcResult.status !== 204) {
    await supabaseRequest('POST', '/rest/v1/payments', { stripe_session_id: stripeSessionId, email, credits, status: 'pending', created_at: new Date().toISOString() }, serviceKey, supabaseHost);
    console.error(`[webhook] add_credits RPC failed (${rpcResult.status}) for ${email}`);
    return { result: 'pending', userUid: null };
  }

  // Record successful payment
  await supabaseRequest('POST', '/rest/v1/payments', { stripe_session_id: stripeSessionId, email, credits, status: 'completed', created_at: new Date().toISOString() }, serviceKey, supabaseHost);
  console.log(`[webhook] ✓ Credited ${credits} credits to ${email} (session ${stripeSessionId})`);
  return { result: 'completed', userUid };
}

async function payReferralReward(userUid, serviceKey, supabaseHost) {
  try {
    const result = await supabaseRequest('POST', '/rest/v1/rpc/pay_referral_reward', { purchased_uid: userUid }, serviceKey, supabaseHost);
    if (result.status === 200 || result.status === 204) {
      console.log(`[webhook] ✓ Referral reward processed for user ${userUid}`);
    } else {
      console.warn(`[webhook] pay_referral_reward returned ${result.status} for user ${userUid}`);
    }
  } catch (e) {
    // Non-fatal — don't fail the whole webhook if referral reward errors
    console.error('[webhook] pay_referral_reward error:', e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return { statusCode: 500, body: 'Webhook secret not configured' };

  const sigHeader = event.headers['stripe-signature'];
  if (!sigHeader) return { statusCode: 400, body: 'Missing Stripe signature' };

  if (!verifyStripeSignature(event.body, sigHeader, webhookSecret)) {
    console.error('[webhook] Signature verification failed');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const email = session.metadata?.commandohsc_email || session.customer_details?.email || session.customer_email || null;
    const credits = session.metadata?.credits ? parseInt(session.metadata.credits, 10) : null;

    if (!email) { console.error('[webhook] No email on session:', session.id); return { statusCode: 200, body: 'No email — skipped' }; }
    if (!credits || isNaN(credits)) { console.error('[webhook] No credits on session:', session.id); return { statusCode: 200, body: 'No credits — skipped' }; }

    const { result, userUid } = await addCredits(email, credits, session.id);

    // Pay referral reward if this was a successful (not duplicate) purchase
    if (result === 'completed' && userUid) {
      const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
      const serviceKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      const supabaseHost = new URL(supabaseUrl).hostname;
      await payReferralReward(userUid, serviceKey, supabaseHost);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true, result }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
