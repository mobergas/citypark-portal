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
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  try {
    const { email } = await req.json();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (cleanEmail) {
      const { data: passes } = await supabase
        .from('passes')
        .select('*')
        .ilike('email', cleanEmail)
        .neq('status', 'canceled');

      if (passes && passes.length) {
        const token = 'pl_' + crypto.randomUUID().replace(/-/g, '');
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

        const ids = passes.map((p: any) => p.id);
        await supabase.from('passes')
          .update({ login_token: token, login_token_expires: expires })
          .in('id', ids);

        const link = `https://cityparkmanagement.app/manage-pass?token=${token}`;
        await sendEmail(
          cleanEmail,
          'Manage Your City Park Monthly Pass',
          `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">holdings</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><h2 style="margin-bottom:8px;">Manage Your Pass</h2><p>Click below to view or update your monthly parking pass details, including your email, license plate, or payment method.</p><div style="text-align:center;margin:28px 0;"><a href="${link}" style="background:#b5d96e;color:#0d0d0d;font-weight:900;font-size:16px;padding:16px 32px;border-radius:10px;text-decoration:none;display:inline-block;text-transform:uppercase;">Manage My Pass</a></div><p style="font-size:13px;color:#888;">This link expires in 30 minutes for your security. If you didn't request this, you can safely ignore this email.</p></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`
        );
      }
      // Always respond the same way whether or not a match was found, so we don't reveal
      // which emails are on file.
    }

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