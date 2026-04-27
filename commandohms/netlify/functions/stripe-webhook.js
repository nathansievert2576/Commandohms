// netlify/functions/stripe-webhook.js
// Receives Stripe checkout.session.completed events
// Adds credits to the user's Supabase account

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role — never expose this to frontend
);

// Credit amounts by amount paid in cents (AUD)
const AMOUNT_TO_CREDITS = {
  399:  10,   // $3.99 AUD → 10 credits  (Starter)
  999:  30,   // $9.99 AUD → 30 credits  (Standard)
  1499: 60,   // $14.99 AUD → 60 credits (Intensive)
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── 1. Verify Stripe signature ──────────────────────────────────────────
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // ── 2. Only handle checkout.session.completed ────────────────────────────
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const sessionId = session.id;

  // ── 3. Idempotency check — prevent duplicate credits on Stripe retries ───
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();

  if (existingPayment) {
    console.log(`Session ${sessionId} already processed — skipping.`);
    return { statusCode: 200, body: 'Already processed' };
  }

  // ── 4. Determine credits from amount paid ────────────────────────────────
  const amountPaid = session.amount_total; // in cents
  const creditsToAdd = AMOUNT_TO_CREDITS[amountPaid];
  if (!creditsToAdd) {
    console.error(`Unknown amount: ${amountPaid} cents`);
    return { statusCode: 400, body: `Unknown amount: ${amountPaid}` };
  }

  // ── 5. Get customer email ────────────────────────────────────────────────
  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) {
    console.error('No email found in session:', sessionId);
    return { statusCode: 400, body: 'No email in session' };
  }

  // ── 6. Look up user by email via admin API ──────────────────────────────
  const { data: adminLookup, error: lookupError } = await supabase.auth.admin.getUserByEmail(customerEmail);
  const userId = adminLookup?.user?.id || null;

  if (lookupError) {
    console.error('Error looking up user by email:', lookupError);
  }

  if (!userId) {
    // ── 7. No account yet — store as pending so no payment is ever lost ────
    console.warn(`No user found for email: ${customerEmail} — storing as pending`);
    await supabase.from('payments').insert({
      user_id: null,
      stripe_session_id: sessionId,
      customer_email: customerEmail,
      credits_added: creditsToAdd,
      amount_aud: amountPaid / 100,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    // Still return 200 so Stripe doesn't keep retrying
    return { statusCode: 200, body: 'User not found — payment stored as pending' };
  }

  // ── 8. Add credits using a safe RPC (atomic increment, no race condition) ─
  const { error: rpcError } = await supabase.rpc('add_credits', {
    uid: userId,
    amount: creditsToAdd,
  });

  if (rpcError) {
    console.error('Error adding credits via RPC:', rpcError);
    return { statusCode: 500, body: 'Error updating credits' };
  }

  // ── 9. Log the completed payment ─────────────────────────────────────────
  const { error: logError } = await supabase.from('payments').insert({
    user_id: userId,
    stripe_session_id: sessionId,
    customer_email: customerEmail,
    credits_added: creditsToAdd,
    amount_aud: amountPaid / 100,
    status: 'completed',
    created_at: new Date().toISOString(),
  });

  if (logError) {
    // Credits were added successfully — log failure is non-fatal
    console.error('Payment log insert failed (credits already added):', logError);
  }

  console.log(`✅ Added ${creditsToAdd} credits to ${customerEmail} (user: ${userId})`);
  return { statusCode: 200, body: 'Credits added successfully' };
};
