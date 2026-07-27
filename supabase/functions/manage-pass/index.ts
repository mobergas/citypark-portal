import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function getValidPass(passId: string, token: string) {
  const { data: passes } = await supabase
    .from('passes')
    .select('*')
    .eq('id', passId)
    .eq('login_token', token);
  if (!passes || !passes.length) throw new Error('Invalid or expired link. Please request a new one.');
  const pass = passes[0];
  if (!pass.login_token_expires || new Date(pass.login_token_expires) < new Date()) {
    throw new Error('This link has expired. Please request a new one.');
  }
  return pass;
}

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
    const body = await req.json();
    const { action, passId, token } = body;

    if (action === 'update_info') {
      const pass = await getValidPass(passId, token);
      const updates: Record<string, unknown> = {};
      if (typeof body.email === 'string' && body.email.trim()) updates.email = body.email.trim().toLowerCase();
      if (typeof body.plate === 'string') updates.plate = body.plate.trim().toUpperCase() || null;
      await supabase.from('passes').update(updates).eq('id', pass.id);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (action === 'update_card') {
      const pass = await getValidPass(passId, token);
      const { paymentMethodId } = body;
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
      const customerId = pass.stripe_customer_id;

      // Attach new payment method
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

      const passUpdates: Record<string, unknown> = { stripe_payment_method_id: paymentMethodId };

      // If they're past due, retry the charge now instead of waiting for next month
      if (pass.status === 'past_due') {
        const amount = pass.custom_price || pass.monthly_amount || 0;
        const piBody = new URLSearchParams({
          amount: Math.round(amount * 100).toString(),
          currency: 'usd',
          customer: customerId,
          payment_method: paymentMethodId,
          description: `Monthly parking pass retry - ${pass.lot_name || 'Lot'} - ${pass.holder_name || pass.name}`,
          confirm: 'true',
          off_session: 'true',
        });
        const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: piBody.toString(),
        });
        const pi = await piRes.json();
        if (!piRes.ok || pi.error) throw new Error(pi.error?.message || 'Your card was saved, but the payment retry failed. Please try again or contact support.');

        const next = new Date();
        next.setMonth(next.getMonth() + 1);
        next.setDate(1);
        next.setHours(0, 0, 0, 0);

        passUpdates.status = 'active';
        passUpdates.card_update_token = null;
        passUpdates.next_bill_date = next.toISOString();
        passUpdates.total_billed = (pass.total_billed || 0) + amount;
      }

      await supabase.from('passes').update(passUpdates).eq('id', pass.id);

      return new Response(JSON.stringify({ success: true, retried: pass.status === 'past_due' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (action === 'cancel') {
      const pass = await getValidPass(passId, token);
      await supabase.from('passes').update({
        status: 'canceled',
        canceled_on: new Date().toISOString(),
        next_bill_date: null,
      }).eq('id', pass.id);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    throw new Error('Unknown action');

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});