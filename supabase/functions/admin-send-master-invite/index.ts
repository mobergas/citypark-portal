import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function sendEmail(to: string, subject: string, html: string) {
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}` },
    body: JSON.stringify({ to, subject, html })
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const { data: callerProfile } = await supabase.from('profiles').select('role,active').eq('id', userData.user.id).single();
    if (!callerProfile || !callerProfile.active || !['admin', 'manager'].includes(callerProfile.role)) {
      return new Response(JSON.stringify({ error: 'Not authorized' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const { masterAccountId, name, email, lotId } = await req.json();

    const { data: accts } = await supabase.from('master_accounts').select('*').eq('id', masterAccountId);
    const acct = accts && accts.length ? accts[0] : null;
    if (!acct) return new Response(JSON.stringify({ error: 'Master account not found.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    if (!(acct.lot_ids || []).includes(lotId)) {
      return new Response(JSON.stringify({ error: 'That lot is not assigned to this account.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const { count } = await supabase.from('passes').select('*', { count: 'exact', head: true }).eq('master_account_id', acct.id).neq('status', 'canceled');
    if ((count || 0) >= acct.pass_cap) {
      return new Response(JSON.stringify({ error: 'Pass cap reached for this account. Increase the cap in Master Accounts to add more.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const { data: lots } = await supabase.from('lots').select('*').eq('id', lotId);
    const lot = lots && lots.length ? lots[0] : null;
    if (!lot) return new Response(JSON.stringify({ error: 'Lot not found.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    const tok = 'tok_' + Math.random().toString(36).slice(2, 18);
    const passId = 'MP-' + Date.now();

    await supabase.from('passes').insert({
      id: passId, name, email, lot_id: lotId, status: 'pending',
      start_date: new Date().toISOString(), monthly_amount: 0, custom_price: 0,
      total_billed: 0, invite_token: tok, signup_token: tok,
      lot_name: lot.name, holder_name: name, master_account_id: acct.id
    });

    const signupLink = `https://cityparkmanagement.app/pass/signup?token=${tok}&lot=${lotId}`;
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><img src="https://sldahhdbvcxdlqdhmsjd.supabase.co/storage/v1/object/public/assets/Logo%201.png" alt="City Park Management" style="height:48px;display:block;"></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><p>Hi ${name},</p><p style="margin-top:12px">You've been invited by <strong>${acct.business_name}</strong> to activate a free parking pass at <strong>${lot.name}</strong>.</p><table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin:20px 0;"><tr><td style="color:#888;font-size:13px;">Lot</td><td style="font-weight:700;">${lot.name}</td></tr><tr><td style="color:#888;font-size:13px;">Zone</td><td style="font-weight:700;">${lot.zone}</td></tr><tr><td style="color:#888;font-size:13px;">Rate</td><td style="font-weight:700;color:#2e7d32;">FREE</td></tr></table><div style="text-align:center;margin:28px 0"><a href="${signupLink}" style="background:#b5d96e;color:#0d0d0d;font-weight:900;font-size:16px;padding:16px 32px;border-radius:10px;text-decoration:none;display:inline-block;letter-spacing:.04em;text-transform:uppercase;">Activate My Pass →</a></div><p style="font-size:13px;color:#888;">Questions? Contact ${acct.business_name} or City Park Management at info@cityparkmanagement.com</p></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Management · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;

    await sendEmail(email, `You're invited to activate a free parking pass at ${lot.name}`, html);

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});