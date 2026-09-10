import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// This function is the only place a monthly pass gets activated. Before this existed, the
// browser confirmed payment (or, for free passes, did nothing) and then PATCHed the pass row
// to status='active' itself, using an amount it computed client-side — a direct REST call
// could skip Stripe entirely and activate any pass for free, or charge whatever amount it
// pleased. Every activation here is gated on a charge amount re-derived server-side from the
// pass/lot record (never trusted from the client), and the token claim is atomic so a signup
// link can't be replayed to activate twice.

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

const ALERT_EMAIL = 'matt@cityparkmanagement.com';
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

function calcProrate(monthlyPrice: number) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysLeft = daysInMonth - dayOfMonth + 1;
  const dailyRate = monthlyPrice / daysInMonth;
  const prorated = +(dailyRate * daysLeft).toFixed(2);
  const nextBill = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { prorated, nextBill };
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
    const body = await req.json();
    const { signupToken, paymentMethodId, plate } = body;
    if (!signupToken) throw new Error('Invalid signup link');

    // The signup link is the only credential here (there's no login), so the lookup that
    // populates the signup page has to be server-side too — passes used to be readable by
    // anyone via the public REST API, which leaked every pass's tokens/Stripe ids to whoever
    // asked. This returns only what the signup page actually displays.
    if (body.action === 'lookup') {
      const { data: pass } = await supabase.from('passes').select('*').eq('signup_token', signupToken).single();
      if (!pass) throw new Error('This invitation link is invalid or has expired.');
      const { data: lot } = await supabase.from('lots').select('pass_restrictions,address,fees').eq('id', pass.lot_id).single();
      const monthlyFee = lot?.fees?.monthly;
      return new Response(JSON.stringify({
        holder_name: pass.holder_name,
        lot_name: pass.lot_name,
        lot_address: lot?.address || '',
        custom_price: pass.custom_price,
        service_fee: monthlyFee?.enabled ? (monthlyFee.amount || 0) : 0,
        status: pass.status,
        token_used: pass.token_used,
        pass_restrictions: lot?.pass_restrictions || null,
        override_restrictions: pass.override_restrictions || false,
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' } });
    }

    const { data: pass } = await supabase.from('passes').select('*').eq('signup_token', signupToken).single();
    if (!pass) throw new Error('This invitation link is invalid or has expired.');
    if (pass.token_used) throw new Error('This invitation has already been used. Please contact us if you need assistance.');
    if (pass.status === 'canceled') throw new Error('This invitation has been canceled. Please contact us for a new invitation.');

    const { data: lot } = await supabase.from('lots').select('fees').eq('id', pass.lot_id).single();
    const monthlyFee = lot?.fees?.monthly;
    const serviceFee = monthlyFee?.enabled ? (monthlyFee.amount || 0) : 0;
    const price = pass.custom_price || pass.monthly_price || 0;
    const cleanPlate = String(plate || '').trim().toUpperCase();

    const updateFields: Record<string, unknown> = {
      status: 'active',
      token_used: true,
      start_date: new Date().toISOString(),
      plate: cleanPlate || null,
      billed_at: new Date().toISOString(),
    };
    let responsePrice = 0;
    let responseNextBill: string | null = null;

    if (price === 0) {
      updateFields.next_bill_date = null;
    } else {
      if (!paymentMethodId) throw new Error('Payment required');
      const { prorated, nextBill } = calcProrate(price);
      const amount = +(prorated + serviceFee).toFixed(2);
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;

      const custBody = new URLSearchParams({ email: pass.email || '', name: pass.holder_name || '' });
      const custRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: custBody.toString(),
      });
      const customer = await custRes.json();
      if (!custRes.ok) throw new Error(customer.error?.message || 'Failed to create customer');

      const attachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ customer: customer.id }).toString(),
      });
      if (!attachRes.ok) { const a = await attachRes.json(); throw new Error(a.error?.message || 'Failed to attach card'); }

      const piBody = new URLSearchParams({
        amount: Math.round(amount * 100).toString(),
        currency: 'usd',
        customer: customer.id,
        payment_method: paymentMethodId,
        description: `Monthly parking pass - ${pass.lot_name || ''} - ${pass.holder_name || ''}`,
        confirm: 'true',
        off_session: 'true',
      });
      const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: piBody.toString(),
      });
      const pi = await piRes.json();
      if (!piRes.ok) throw new Error(pi.error?.message || 'Failed to charge card');

      updateFields.stripe_customer_id = customer.id;
      updateFields.stripe_payment_method_id = paymentMethodId;
      updateFields.next_bill_date = nextBill.toISOString();
      updateFields.service_fee = serviceFee;
      responsePrice = price;
      responseNextBill = nextBill.toISOString();
    }

    // Atomic claim: token_used=false in the filter means this only succeeds once, so a
    // retried or replayed request can't double-activate a pass that's already live.
    const { data: updated, error } = await supabase
      .from('passes')
      .update(updateFields)
      .eq('signup_token', signupToken)
      .eq('token_used', false)
      .select()
      .single();
    if (error || !updated) {
      if (responsePrice > 0) {
        await sendAdminAlert(`pass-activation-failed:${signupToken}`, 'Charged customer but pass activation failed', `A card was charged $${responsePrice + (updateFields.service_fee as number || 0)} for pass signup_token ${signupToken} (${pass.holder_name || pass.email || 'unknown'}), but the activation update failed${error ? ': ' + error.message : ' (claim returned no row, but this was not a normal "already used" case since a charge just happened)'}. This customer paid and their pass is not active.`);
      }
      throw new Error('This invitation has already been used. Please contact us if you need assistance.');
    }

    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ type: 'pass_activated', id: updated.id, email: updated.email }),
    }).catch(() => {});

    return new Response(JSON.stringify({ success: true, price: responsePrice, nextBill: responseNextBill }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
