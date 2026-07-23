import Stripe from 'https://esm.sh/stripe@13.3.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

function calcSessionTotal(lot: any, rate: string, hours: number, val: any) {
  const p = lot.pricing;
  const f = (lot.fees && lot.fees[rate]) || { enabled: false, amount: 0 };
  let base = rate === 'hourly' ? p.hourly * hours : rate === 'event' ? p.event : p.monthly;
  const fee = f.enabled ? f.amount : 0;
  let disc = 0;
  if (val) {
    if (val.type === 'free') disc = base + fee;
    else if (val.type === 'percent') disc = +(base * (val.discount_pct / 100)).toFixed(2);
    else disc = Math.min(val.discount_amt, base);
  }
  const total = Math.max(0, base + fee - disc);
  return { base: +base.toFixed(2), fee: +fee.toFixed(2), disc: +disc.toFixed(2), total: +total.toFixed(2) };
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
    const { mode, sessionId, description } = body;
    let amount, base = 0, fee = 0, disc = 0;

    if (mode === 'extend') {
      const { data: sess } = await supabase.from('sessions').select('*').eq('id', body.existingSessionId).single();
      if (!sess) throw new Error('Session not found');
      const { data: lot } = await supabase.from('lots').select('*').eq('id', sess.lot_id).single();
      if (!lot) throw new Error('Lot not found');
      const hours = Math.max(1, Math.min(12, parseInt(body.hours) || 1));
      const f = (lot.fees && lot.fees.hourly) || { enabled: false, amount: 0 };
      base = +(lot.pricing.hourly * hours).toFixed(2);
      fee = f.enabled ? f.amount : 0;
      amount = +(base + fee).toFixed(2);
    } else {
      const { data: lot } = await supabase.from('lots').select('*').eq('id', body.lotId).single();
      if (!lot) throw new Error('Lot not found');
      const rate = ['hourly','event','monthly'].includes(body.rate) ? body.rate : 'hourly';
      const hours = rate === 'hourly' ? Math.max(1, Math.min(12, parseInt(body.hours) || 1)) : 0;

      let val = null;
      if (body.valCode) {
        const { data: vals } = await supabase.from('validations').select('*').eq('code', String(body.valCode).toUpperCase()).eq('active', true);
        val = (vals || []).find((v: any) => (v.lot_ids || [v.lot_id]).includes(lot.id)) || null;
      }

      const calc = calcSessionTotal(lot, rate, hours, val);
      amount = calc.total; base = calc.base; fee = calc.fee; disc = calc.disc;
    }

    if (amount <= 0) throw new Error('Amount must be greater than zero for a card payment');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      description,
      metadata: { sessionId: sessionId || '' },
    });

    return new Response(JSON.stringify({
      clientSecret: paymentIntent.client_secret,
      amount, base, fee, disc
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});