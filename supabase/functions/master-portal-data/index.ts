import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// master-portal.html previously read master_accounts and passes straight from the public
// REST API. The master_accounts SELECT policy had no row-level scoping at all, so any
// unauthenticated request — no business_token required — returned every master account's
// business_token (the only credential that portal has), plus every invited pass's contact
// info. This function does the same lookup server-side, checking the caller's token before
// returning anything, and returns only the fields the portal actually displays.

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
    const { businessToken } = await req.json();
    if (!businessToken) throw new Error('Invalid portal link.');

    const { data: acct } = await supabase.from('master_accounts').select('*').eq('business_token', businessToken).single();
    if (!acct) throw new Error('Portal not found. Please contact City Park Management.');
    if (!acct.active) throw new Error('This account is currently inactive. Please contact City Park Management.');

    const { data: lots } = await supabase.from('lots').select('id,name,zone').in('id', acct.lot_ids || []);
    const { data: passes } = await supabase.from('passes').select('id,name,email,status').eq('master_account_id', acct.id).order('created_at', { ascending: false });

    return new Response(JSON.stringify({
      account: { business_name: acct.business_name, pass_cap: acct.pass_cap },
      lots: lots || [],
      passes: passes || [],
    }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
