import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MAX_REQUESTS = 3;
const WINDOW_MS = 15 * 60 * 1000;

// Only ever redirect back to a known staff login page — never an arbitrary client-supplied
// URL, which would otherwise turn this into an open redirect for phishing.
const ALLOWED_PATHS: Record<string, string> = {
  admin: '/admin',
  enforce: '/enforce',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const { email, app } = await req.json();
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) throw new Error('Valid email required');
    const path = ALLOWED_PATHS[app];
    if (!path) throw new Error('Invalid app');

    // Throttle per email so this can't be used to spam one address with reset emails,
    // regardless of what IP the requests come from.
    const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
    await supabase.from('password_reset_requests').delete().eq('email', cleanEmail).lt('created_at', windowStart);
    const { count } = await supabase
      .from('password_reset_requests')
      .select('*', { count: 'exact', head: true })
      .eq('email', cleanEmail)
      .gte('created_at', windowStart);
    if ((count || 0) >= MAX_REQUESTS) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many requests for this email. Please wait 15 minutes and try again.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    await supabase.from('password_reset_requests').insert({ email: cleanEmail });

    const redirectTo = encodeURIComponent(`${Deno.env.get('SITE_URL') || 'https://www.cityparkmanagement.app'}${path}`);
    await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/recover?redirect_to=${redirectTo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': Deno.env.get('SUPABASE_ANON_KEY')! },
      body: JSON.stringify({ email: cleanEmail })
    });

    // Always respond the same way regardless of whether the email matched an account, so
    // this can't be used to enumerate which emails have staff accounts.
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
