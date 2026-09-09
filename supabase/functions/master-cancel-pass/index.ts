import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const { businessToken, passId } = await req.json();
    if (!businessToken || !passId) throw new Error('businessToken and passId required');

    const { data: accts } = await supabase.from('master_accounts').select('id, active').eq('business_token', businessToken);
    const acct = accts && accts.length ? accts[0] : null;
    if (!acct || !acct.active) throw new Error('Invalid or inactive account.');

    // Confirm the pass actually belongs to this master account before canceling it — the
    // request itself only carries a pass id, and passes' own RLS policy doesn't verify
    // ownership, so this check is the only thing standing between one account and every
    // other pass in the system.
    const { data: passes } = await supabase.from('passes').select('id, master_account_id').eq('id', passId);
    const pass = passes && passes.length ? passes[0] : null;
    if (!pass || pass.master_account_id !== acct.id) throw new Error('Pass not found for this account.');

    await supabase.from('passes').update({ status: 'canceled', next_bill_date: null }).eq('id', passId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
