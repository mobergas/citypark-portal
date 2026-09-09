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
        'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  try {
    const { email, password } = await req.json();
    if (!email || !password) throw new Error('email and password required');

    const normEmail = String(email).toLowerCase().trim();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

    // Drop stale attempts for this email so the table doesn't grow unbounded.
    await supabase.from('login_attempts').delete().eq('email', normEmail).lt('created_at', windowStart);

    const { count } = await supabase
      .from('login_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('email', normEmail)
      .eq('success', false)
      .gte('created_at', windowStart);

    if ((count || 0) >= MAX_ATTEMPTS) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many failed attempts. Login locked for 10 minutes.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
      });
    }

    const tokenRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': Deno.env.get('SUPABASE_ANON_KEY')!
      },
      body: JSON.stringify({ email, password })
    });

    const success = tokenRes.ok;
    await supabase.from('login_attempts').insert({ email: normEmail, ip, success });

    if (!success) {
      const remaining = MAX_ATTEMPTS - ((count || 0) + 1);
      const message = remaining > 0
        ? `Invalid email or password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many failed attempts. Login locked for 10 minutes.';
      return new Response(JSON.stringify({ error: 'invalid_credentials', message }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
      });
    }

    const data = await tokenRes.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
