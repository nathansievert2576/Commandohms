// netlify/functions/stripe-webhook.js
// Receives Stripe checkout.session.completed events
// Adds credits to the user's Supabase account

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role — never expose this to frontend
);

// Credit amounts per Stripe payment link
// Key = Stripe price ID, Value = credits to add
const CREDITS_MAP = {
  'starter':   10,  // $3.99
  'standard':  30,  // $9.99
  'intensive': 60,  // $14.99
};

// Map your Stripe Payment Link URLs to credit amounts
// We'll use the metadata set on the payment link
const AMOUNT_TO_CREDITS = {
  399:  10,   // $3.99 AUD → 10 credits
  999:  30,   // $9.99 AUD → 30 credits
  1499: 60,   // $14.99 AUD → 60 credits
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

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

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;

  // Get user email from Stripe session
  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) {
    console.error('No email found in session');
    return { statusCode: 400, body: 'No email in session' };
  }

  // Determine credits from amount paid
  const amountPaid = session.amount_total; // in cents
  const creditsToAdd = AMOUNT_TO_CREDITS[amountPaid];
  if (!creditsToAdd) {
    console.error(`Unknown amount: ${amountPaid}`);
    return { statusCode: 400, body: `Unknown amount: ${amountPaid}` };
  }

  // Look up the user in Supabase auth by email
  const { data: users, error: userError } = await supabase.auth.admin.listUsers();
  if (userError) {
    console.error('Error fetching users:', userError);
    return { statusCode: 500, body: 'Error fetching users' };
  }

  const user = users.users.find(u => u.email === customerEmail);
  if (!user) {
    console.error(`No user found for email: ${customerEmail}`);
    // Store as pending — user may not have signed up yet
    return { statusCode: 200, body: 'User not found — payment logged for manual processing' };
  }

  // Add credits to user
  const { data: currentCredits, error: fetchError } = await supabase
    .from('user_credits')
    .select('credits, total_purchased')
    .eq('user_id', user.id)
    .single();

  if (fetchError) {
    console.error('Error fetching credits:', fetchError);
    return { statusCode: 500, body: 'Error fetching credits' };
  }

  const newCredits = (currentCredits.credits || 0) + creditsToAdd;
  const newTotal = (currentCredits.total_purchased || 0) + creditsToAdd;

  const { error: updateError } = await supabase
    .from('user_credits')
    .update({
      credits: newCredits,
      total_purchased: newTotal,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', user.id);

  if (updateError) {
    console.error('Error updating credits:', updateError);
    return { statusCode: 500, body: 'Error updating credits' };
  }

  // Log the payment
  await supabase.from('payments').insert({
    user_id: user.id,
    stripe_session_id: session.id,
    credits_added: creditsToAdd,
    amount_aud: amountPaid / 100,
  });

  console.log(`Added ${creditsToAdd} credits to ${customerEmail}. New balance: ${newCredits}`);
  return { statusCode: 200, body: 'Credits added successfully' };
};
