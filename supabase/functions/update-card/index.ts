import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function sendEmail(to: string, subject: string, html: string) {
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
    body: JSON.stringify({ to, subject, html })
  });
}

const ALERT_EMAIL = 'info@cityparkmanagement.com';
const ALERT_DEDUP_MS = 30 * 60 * 1000;

async function sendAdminAlert(key: string, subject: string, details: string) {
  try {
    const windowStart = new Date(Date.now() - ALERT_DEDUP_MS).toISOString();
    const { data: recent } = await supabase.from('admin_alerts').select('id').eq('alert_key', key).gte('created_at', windowStart).limit(1);
    if (recent && recent.length) return;
    await supabase.from('admin_alerts').insert({ alert_key: key, details });
    await sendEmail(ALERT_EMAIL, `⚠️ City Park Alert: ${subject}`, `<p>${details}</p><p style="color:#888;font-size:12px">Sent ${new Date().toISOString()}</p>`);
  } catch (e) {
    console.error('sendAdminAlert failed:', e);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
    const body = await req.json();

    // The card-update link's token is the only thing gating this page, so the initial lookup
    // that populates it has to be server-side too — passes used to be readable by anyone via
    // the public REST API with no token check at all. Returns only what the page displays,
    // plus stripe_customer_id which the follow-up update call needs.
    if (body.action === 'lookup') {
      const { token } = body;
      const { data: passes } = await supabase
        .from('passes')
        .select('id,status,stripe_customer_id,holder_name,name,lot_name,custom_price,monthly_amount,service_fee')
        .eq('card_update_token', token);
      if (!passes || !passes.length) throw new Error('This link is invalid or has expired.');
      return new Response(JSON.stringify(passes[0]), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
      });
    }

    if (body.action === 'finalize') {
      const { passId, token, paymentIntentId } = body;

      // Re-checking id+token together means a second call with the same (now-cleared)
      // token can't credit the pass twice.
      const { data: passes } = await supabase.from('passes').select('*').eq('id', passId).eq('card_update_token', token);
      if (!passes || !passes.length) throw new Error('Invalid token');
      const pass = passes[0];

      const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
        headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':') },
      });
      const pi = await piRes.json();
      if (!piRes.ok) throw new Error(pi.error?.message || 'Could not verify payment');
      if (pi.status !== 'succeeded') throw new Error('Payment has not completed');
      if (pi.customer !== pass.stripe_customer_id) throw new Error('Payment does not match this pass');

      const amount = (pass.custom_price || pass.monthly_amount || 0) + (pass.service_fee || 0);
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(0, 0, 0, 0);

      const { error: updateErr } = await supabase.from('passes').update({
        status: 'active',
        stripe_payment_method_id: pi.payment_method,
        card_update_token: null,
        next_bill_date: next.toISOString(),
        total_billed: (pass.total_billed || 0) + amount
      }).eq('id', passId);
      if (updateErr) {
        await sendAdminAlert(`update-card-finalize-failed:${passId}`, 'Charged customer but pass update failed', `PaymentIntent ${paymentIntentId} was verified as paid ($${amount}) as a card-update retry for pass ${passId} (${pass.holder_name || pass.name}), but the passes update failed: ${updateErr.message}. This customer paid and their pass still shows past_due.`);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
      });
    }

    const { passId, customerId, paymentMethodId, token } = body;

    // Verify token
    const { data: passes } = await supabase.from('passes').select('*').eq('id', passId).eq('card_update_token', token);
    if (!passes || !passes.length) throw new Error('Invalid token');
    const pass = passes[0];

    // Recompute the amount from the pass record itself — never trust a client-supplied
    // dollar amount for something that generates a real Stripe charge.
    const amount = (pass.custom_price || pass.monthly_amount || 0) + (pass.service_fee || 0);
    if (amount <= 0) throw new Error('Nothing due on this pass');

    // Attach new payment method to customer
    const attachBody = new URLSearchParams({ customer: customerId });
    await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: attachBody.toString(),
    });

    // Set as default payment method
    const updateBody = new URLSearchParams({ 'invoice_settings[default_payment_method]': paymentMethodId });
    await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: updateBody.toString(),
    });

    // Create and confirm the retry charge. The customer is actively present on this page,
    // so this is NOT off_session — that flag made Stripe hard-fail with authentication_required
    // instead of returning requires_action, meaning a card needing 3D Secure could never
    // recover here. Without it, Stripe returns requires_action + a client_secret when a
    // challenge is needed, and the client completes it with stripe.confirmCardPayment().
    const piBody = new URLSearchParams({
      amount: Math.round(amount * 100).toString(),
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      description: `Monthly parking pass retry - ${pass.lot_name||'Lot'} - ${pass.holder_name||pass.name}`,
      confirm: 'true',
      // Same convention as manage-pass's retry charge — deterministic per past-due
      // episode, so this and that other entry point can't double-charge the same one.
    });

    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(stripeKey + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `retry-${pass.id}-${pass.past_due_since}`,
      },
      body: piBody.toString(),
    });
    const pi = await piRes.json();

    if (!piRes.ok || pi.error) throw new Error(pi.error?.message || 'Payment failed');

    return new Response(JSON.stringify({ clientSecret: pi.client_secret, paymentIntentId: pi.id, status: pi.status }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
