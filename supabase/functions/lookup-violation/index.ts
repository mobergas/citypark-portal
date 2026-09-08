import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MAX_ATTEMPTS = 15;
const WINDOW_MS = 10 * 60 * 1000;

// Only what the public payfine.html page actually displays — never staff-internal fields
// like photo_url/photo_urls or issued_by.
const SAFE_FIELDS = 'id,plate,lot_name,violation_name,created_at,notes,parking_fee,fine_amount,status,paid_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const { query } = await req.json();
    const input = String(query || '').trim().toUpperCase();
    if (!input) throw new Error('query required');

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

    await supabase.from('violation_lookup_attempts').delete().lt('created_at', windowStart);

    const { count } = await supabase
      .from('violation_lookup_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('created_at', windowStart);

    if ((count || 0) >= MAX_ATTEMPTS) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many lookups. Please wait a few minutes and try again.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    await supabase.from('violation_lookup_attempts').insert({ ip });

    let violations;
    if (input.startsWith('VIO-')) {
      const { data } = await supabase.from('violations').select(SAFE_FIELDS).eq('id', input);
      violations = data;
    } else {
      const { data } = await supabase.from('violations').select(SAFE_FIELDS).eq('plate', input).eq('status', 'unpaid').order('created_at', { ascending: false });
      violations = data;
    }

    return new Response(JSON.stringify({ violations: violations || [] }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});
