import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000;

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
    const { code, lotId } = await req.json();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

    const { count } = await supabase
      .from('code_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip', ip)
      .eq('lot_id', lotId)
      .gte('created_at', windowStart);

    if ((count || 0) >= MAX_ATTEMPTS) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many invalid attempts. Please wait 10 minutes.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const upperCode = String(code || '').toUpperCase().trim();

    const { data: vals } = await supabase
      .from('validations')
      .select('*')
      .eq('code', upperCode)
      .eq('active', true);
    const val = (vals || []).find((v: any) => (v.lot_ids || [v.lot_id]).includes(lotId));

    if (val) {
      return new Response(JSON.stringify({
        valid: true,
        val: { id: val.id, name: val.name, code: val.code, type: val.type, discountPct: val.discount_pct, discountAmt: val.discount_amt, maxHours: val.max_hours, active: val.active }
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const { data: compCodes } = await supabase
      .from('comp_codes')
      .select('*')
      .eq('code', upperCode)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString());

    if (compCodes && compCodes.length) {
      const comp = compCodes[0];
      return new Response(JSON.stringify({
        valid: true,
        val: { id: comp.id, name: 'Comp Code', code: comp.code, type: 'free', discountPct: 0, discountAmt: 0, maxHours: 0, active: true, isComp: true }
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await supabase.from('code_attempts').insert({ lot_id: lotId, ip });
    const remaining = MAX_ATTEMPTS - ((count || 0) + 1);

    return new Response(JSON.stringify({
      valid: false,
      remaining: Math.max(0, remaining),
      message: remaining > 0 ? `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : 'Too many invalid attempts. Please wait 10 minutes.'
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