import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// business-portal.html previously PATCHed the validations table directly with the anon key,
// scoped only by a `?business_token=eq.X` filter in the query string. RLS enforced nothing
// beyond that — the filter was a courtesy, not a boundary — so any caller could target a
// different row's id instead and rewrite another business's discount code, amount, or active
// flag. This function does the same lookup and regeneration server-side with the service role,
// so the token is actually checked before anything is written.

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const { token } = await req.json();
    if (!token) throw new Error('Invalid portal link');

    const { data: val } = await supabase.from('validations').select('*').eq('business_token', token).single();
    if (!val) throw new Error('Portal not found. Please contact City Park Management.');

    const prev = val.previous_codes || [];
    prev.push({ code: val.code, generated_at: new Date().toISOString(), expires_at: new Date().toISOString() });

    // code has a database-level UNIQUE constraint, so a collision just fails the update —
    // retry with a fresh random code a few times instead of surfacing that to the caller.
    let updated = null;
    for (let attempt = 0; attempt < 5 && !updated; attempt++) {
      const newCode = genCode();
      const { data } = await supabase.from('validations').update({ code: newCode, previous_codes: prev }).eq('id', val.id).select().single();
      if (data) updated = data;
    }
    if (!updated) throw new Error('Error updating code. Please try again.');

    return new Response(JSON.stringify({ success: true, code: updated.code, previous_codes: updated.previous_codes }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
