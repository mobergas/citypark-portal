import { withCors } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MAX_ATTEMPTS = 15;
const WINDOW_MS = 10 * 60 * 1000;

// Only what the public payfine.html page actually displays — never staff-internal fields
// like photo_url/photo_urls or issued_by. lot_id is only selected so the lot's category can be
// looked up for wording (marina vs parking); it is stripped before the response goes out.
const SAFE_FIELDS = 'id,plate,lot_id,lot_name,violation_name,created_at,notes,parking_fee,slip_number,fine_amount,status,paid_at';

Deno.serve(withCors(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
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

    const lotIds = [...new Set((violations || []).map((v: any) => v.lot_id).filter(Boolean))];
    const categories: Record<string, string> = {};
    if (lotIds.length) {
      const { data: lotRows } = await supabase.from('lots').select('id,category').in('id', lotIds);
      (lotRows || []).forEach((l: any) => { categories[l.id] = l.category; });
    }
    const result = (violations || []).map(({ lot_id, ...rest }: any) => ({ ...rest, category: categories[lot_id] || 'parking' }));

    return new Response(JSON.stringify({ violations: result }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
}));
