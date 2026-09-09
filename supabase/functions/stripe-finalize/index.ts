import Stripe from 'https://esm.sh/stripe@13.3.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// This function is the one place a parking session, an extension, or a violation payment
// actually gets written to the database as "paid". Before this existed, the browser created
// those rows itself right after Stripe.js reported success — which meant a request straight
// to the REST API, skipping Stripe entirely, could fabricate a fully "paid" session or mark
// any violation paid with nothing ever charged. Every write here is gated on either a
// Stripe-verified PaymentIntent (status + exact amount, re-derived from lot/violation data,
// never trusted from the client) or a freshly re-validated $0 discount code.

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });
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
    const discBase = (rate === 'hourly' && val.max_hours > 0) ? p.hourly * Math.min(hours, val.max_hours) : base;
    if (val.dont_bill || val.type === 'free') disc = discBase + fee;
    else if (val.type === 'percent') disc = +(discBase * (val.discount_pct / 100)).toFixed(2);
    else disc = Math.min(val.discount_amt, discBase);
  }
  const total = Math.max(0, base + fee - disc);
  return { base: +base.toFixed(2), fee: +fee.toFixed(2), disc: +disc.toFixed(2), total: +total.toFixed(2) };
}

async function verifyPI(paymentIntentId: string, expectedMetaSessionId: string) {
  if (!paymentIntentId) throw new Error('Payment required');
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!pi) throw new Error('Payment not found');
  if (pi.status !== 'succeeded' && pi.status !== 'requires_capture') throw new Error('Payment has not completed');
  if (pi.metadata?.sessionId !== expectedMetaSessionId) throw new Error('Payment does not match this request');
  return pi;
}

// Server-side lookup of an active business validation or single-use comp code, mirroring
// validate-code's own logic. Returns a normalized shape either way so callers don't need to
// branch on which kind it was, plus an atomicCompClaim() to call once the caller is ready to
// actually commit to using it (comp codes are single-use, so this shouldn't be claimed until
// everything else about the request has already checked out).
async function lookupCode(code: string, lotId: string, plate: string) {
  const upper = String(code || '').toUpperCase().trim();
  if (!upper) return null;
  const { data: vals } = await supabase.from('validations').select('*').eq('code', upper).eq('active', true);
  const val = (vals || []).find((v: any) => (v.lot_ids || [v.lot_id]).includes(lotId));
  if (val) return { kind: 'validation', id: val.id, type: val.type, dont_bill: val.dont_bill, discount_pct: val.discount_pct, discount_amt: val.discount_amt, max_hours: val.max_hours, claim: async () => true };

  const { data: compCodes } = await supabase.from('comp_codes').select('*').eq('code', upper).is('used_at', null).gt('expires_at', new Date().toISOString());
  const comp = compCodes && compCodes.length ? compCodes[0] : null;
  if (comp) return {
    kind: 'comp', id: comp.id, type: 'free', dont_bill: false, discount_pct: 0, discount_amt: 0, max_hours: 0,
    claim: async () => {
      const { data: rows } = await supabase.from('comp_codes').update({ used_at: new Date().toISOString(), used_by_plate: plate }).eq('id', comp.id).is('used_at', null).select();
      return !!(rows && rows.length);
    }
  };
  return null;
}

function ok(data: any) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const body = await req.json();
    const { mode } = body;

    if (mode === 'session') {
      const { sessionId, paymentIntentId, lotId, rate, hours, valCode, plate, vehicle, phone, email } = body;
      const cleanPlate = String(plate || '').trim().toUpperCase();
      if (!cleanPlate) throw new Error('Plate required');
      if (!sessionId || !lotId) throw new Error('Missing session details');

      const { data: existing } = await supabase.from('sessions').select('id').eq('id', sessionId);
      if (existing && existing.length) throw new Error('This session has already been recorded');

      const { data: lot } = await supabase.from('lots').select('*').eq('id', lotId).single();
      if (!lot) throw new Error('Lot not found');
      const r = ['hourly', 'event'].includes(rate) ? rate : 'hourly';
      const dur = r === 'hourly' ? Math.max(1, Math.min(12, parseInt(hours) || 1)) : 12;

      const code = valCode ? await lookupCode(valCode, lot.id, cleanPlate) : null;
      const calcVal = code ? { type: code.type, dont_bill: code.dont_bill, discount_pct: code.discount_pct, discount_amt: code.discount_amt, max_hours: code.max_hours } : null;
      const calc = calcSessionTotal(lot, r, dur, calcVal);

      let storedPaymentIntentId: string | null = null;
      if (calc.total > 0) {
        const pi = await verifyPI(paymentIntentId, sessionId);
        if (Math.round(calc.total * 100) !== pi.amount) throw new Error('Amount mismatch — please try again');
        storedPaymentIntentId = paymentIntentId;
      }

      // Only claim a single-use comp code once the request has fully checked out — claiming
      // earlier and failing afterward would burn the code for nothing.
      if (code && code.kind === 'comp') {
        const claimed = await code.claim();
        if (!claimed) throw new Error('This code has already been used. Please enter a different code or pay normally.');
      }

      const typeLabel = r === 'hourly' ? 'Hourly' : 'Event Parking';
      const { data: inserted, error } = await supabase.from('sessions').insert({
        id: sessionId, plate: cleanPlate, type: typeLabel, rate: r,
        start_time: Date.now(), duration: dur, paid: calc.total, pkch: calc.base, sfee: calc.fee, disc: calc.disc,
        vehicle: vehicle || null, phone: phone || null, email: email || '', lot_id: lot.id,
        val_id: code ? code.id : null, payment_intent_id: storedPaymentIntentId, captured: false,
        sms_sent: false, receipt_sent: false, val_window_min: lot.val_window_minutes ?? 15
      }).select().single();
      if (error) throw error;
      return ok({ session: inserted });
    }

    if (mode === 'extend') {
      const { sessionId, paymentIntentId, hours } = body;
      const { data: sess } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
      if (!sess) throw new Error('Session not found');
      const { data: lot } = await supabase.from('lots').select('*').eq('id', sess.lot_id).single();
      if (!lot) throw new Error('Lot not found');
      const hrs = Math.max(1, Math.min(12, parseInt(hours) || 1));
      const f = (lot.fees && lot.fees.hourly) || { enabled: false, amount: 0 };
      const base = +(lot.pricing.hourly * hrs).toFixed(2);
      const fee = f.enabled ? f.amount : 0;
      const amount = +(base + fee).toFixed(2);

      const pi = await verifyPI(paymentIntentId, sessionId + '-ext');
      if (Math.round(amount * 100) !== pi.amount) throw new Error('Amount mismatch — please try again');
      // An extension's payment intent isn't tracked on the session row (each extend attempt
      // reuses the same "<id>-ext" metadata, so it can't be an idempotency key the way
      // session/violation payments are) — so replaying the same already-succeeded
      // PaymentIntent here would credit duration twice for one real charge. Stripe's own
      // metadata is the guard instead: refuse a PI this function has already finalized once.
      if (pi.metadata?.finalized === 'true') throw new Error('This payment has already been applied.');

      const newDuration = sess.duration + hrs;
      const newPaid = +(sess.paid + amount).toFixed(2);
      const { error } = await supabase.from('sessions').update({ duration: newDuration, paid: newPaid }).eq('id', sessionId);
      if (error) throw error;
      await stripe.paymentIntents.update(paymentIntentId, { metadata: { ...pi.metadata, finalized: 'true' } });
      return ok({ duration: newDuration, paid: newPaid });
    }

    if (mode === 'violation') {
      const { violationId, paymentIntentId } = body;
      const { data: violation } = await supabase.from('violations').select('*').eq('id', violationId).single();
      if (!violation) throw new Error('Violation not found');
      if (violation.status === 'paid') throw new Error('This violation has already been paid');
      const pi = await verifyPI(paymentIntentId, violationId);
      if (Math.round(violation.fine_amount * 100) !== pi.amount) throw new Error('Amount mismatch — please try again');
      const { error } = await supabase.from('violations').update({ status: 'paid', paid_at: new Date().toISOString(), paid_amount: violation.fine_amount }).eq('id', violationId);
      if (error) throw error;
      return ok({ success: true });
    }

    if (mode === 'apply-val') {
      const { sessionId, code } = body;
      const { data: sess } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
      if (!sess) throw new Error('Session not found');
      if (sess.captured) throw new Error('This session has already been captured — a code can no longer be applied.');

      const matched = await lookupCode(code, sess.lot_id, sess.plate);
      if (!matched) throw new Error('Invalid or inactive code.');

      const discBase = (sess.rate === 'hourly' && matched.max_hours > 0)
        ? +(sess.pkch / sess.duration * Math.min(sess.duration, matched.max_hours)).toFixed(2)
        : sess.pkch;
      let disc = 0;
      if (matched.dont_bill || matched.type === 'free') disc = discBase;
      else if (matched.type === 'percent') disc = +(discBase * (matched.discount_pct / 100)).toFixed(2);
      else disc = Math.min(matched.discount_amt, discBase);
      const newAmount = Math.max(0, +(sess.pkch - disc + sess.sfee).toFixed(2));

      if (sess.payment_intent_id) {
        const captureRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/stripe-capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
          body: JSON.stringify(newAmount === 0
            ? { paymentIntentId: sess.payment_intent_id, cancel: true }
            : { paymentIntentId: sess.payment_intent_id, amount: newAmount, originalAmount: sess.pkch + sess.sfee })
        });
        const captureData = await captureRes.json();
        if (!captureRes.ok || captureData.error) throw new Error(captureData.error || 'Could not adjust the charge for this code');
      }

      if (matched.kind === 'comp') {
        const claimed = await matched.claim();
        if (!claimed) {
          await supabase.from('audit_log').insert({ action: 'Comp code redemption race detected', details: `${matched.id} was already used elsewhere when session ${sessionId} tried to redeem it` });
        }
      }

      const discAmt = Math.max(0, +(sess.pkch + sess.sfee - newAmount).toFixed(2));
      const newDuration = (matched.max_hours > 0 && matched.max_hours > sess.duration) ? matched.max_hours : sess.duration;
      const { error } = await supabase.from('sessions').update({ paid: newAmount, disc: discAmt, val_id: matched.id, captured: true, duration: newDuration }).eq('id', sessionId);
      if (error) throw error;
      return ok({ paid: newAmount, disc: discAmt, duration: newDuration, valId: matched.id, isComp: matched.kind === 'comp' });
    }

    throw new Error('Invalid mode');
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
