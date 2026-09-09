import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Customer-facing session lookups (Find My Ticket, restoring an active session on refresh or
// from a texted extend link) used to work by downloading up to 100 of the most recent sessions
// across every lot — plate, phone, email, vehicle, all of it — into every visitor's browser on
// every page load, whether or not they ever used either feature. This does the same lookups
// server-side instead, rate-limited per IP like lookup-violation.

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MAX_ATTEMPTS = 20;
const WINDOW_MS = 10 * 60 * 1000;

// by_contact is a plate-or-phone search anyone could run against a guessed value, so it
// deliberately excludes contact info — same policy lookup-violation already applies to its
// own public plate search.
const CONTACT_SAFE_FIELDS = 'id,plate,type,rate,start_time,duration,paid,lot_id,val_id,val_window_min';
// by_id requires knowing the exact ticket id (the customer's own receipt/SMS link), so the
// full row is fine — it's the same data finalizePayment already handed back to them directly.
const FULL_FIELDS = 'id,plate,type,rate,start_time,duration,paid,pkch,sfee,disc,vehicle,phone,sms_sent,receipt_sent,email,lot_id,val_id,payment_intent_id,captured,val_window_min';

async function rateLimit(ip: string) {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  await supabase.from('session_lookup_attempts').delete().lt('created_at', windowStart);
  const { count } = await supabase
    .from('session_lookup_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', windowStart);
  if ((count || 0) >= MAX_ATTEMPTS) return false;
  await supabase.from('session_lookup_attempts').insert({ ip });
  return true;
}

function ok(data: unknown) {
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
    const { action } = body;
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    const allowed = await rateLimit(ip);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many lookups. Please wait a few minutes and try again.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
      });
    }

    if (action === 'by_id') {
      const id = String(body.id || '').trim();
      if (!id) throw new Error('id required');
      const { data } = await supabase.from('sessions').select(FULL_FIELDS).eq('id', id).single();
      return ok({ session: data || null });
    }

    if (action === 'by_contact') {
      const input = String(body.query || '').trim().toUpperCase();
      if (!input) throw new Error('query required');
      const { data } = await supabase
        .from('sessions')
        .select(CONTACT_SAFE_FIELDS)
        .or(`plate.eq.${input},phone.eq.${input}`)
        .order('created_at', { ascending: false })
        .limit(20);
      // remMs (has this session expired) is computed the same way the client does, using
      // start_time + duration — filtered server-side so an expired ticket from weeks ago
      // doesn't show up in someone else's search just because the plate matches.
      const now = Date.now();
      const active = (data || []).filter((s: any) => s.start_time + s.duration * 3600000 > now);
      return ok({ sessions: active });
    }

    throw new Error('Invalid action');
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
