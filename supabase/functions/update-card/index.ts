import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  try {
    const { passId, customerId, paymentMethodId, amount, token } = await req.json();
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;

    // Verify token
    const { data: passes } = await supabase.from('passes').select('*').eq('id', passId).eq('card_update_token', token);
    if (!passes || !passes.length) throw new Error('Invalid token');
    const pass = passes[0];

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

    // Retry the charge
    const piBody = new URLSearchParams({
      amount: Math.round(amount * 100).toString(),
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      description: `Monthly parking pass retry - ${pass.lot_name||'Lot'} - ${pass.holder_name||pass.name}`,
      confirm: 'true',
      off_session: 'true',
    });

    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: piBody.toString(),
    });
    const pi = await piRes.json();

    if (!piRes.ok || pi.error) throw new Error(pi.error?.message || 'Payment failed');

    // Update pass - reactivate and clear token
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    next.setDate(1);
    next.setHours(0,0,0,0);

    await supabase.from('passes').update({
      status: 'active',
      stripe_payment_method_id: paymentMethodId,
      card_update_token: null,
      next_bill_date: next.toISOString(),
      total_billed: (pass.total_billed || 0) + amount
    }).eq('id', passId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});