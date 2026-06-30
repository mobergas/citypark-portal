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

Deno.serve(async () => {
  const now = Date.now();

  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('sms_sent', false);

  for (const s of sessions || []) {
    const start = new Date(s.start_time).getTime();
    const expiry = start + s.duration * 3600000;
    const remaining = expiry - now;

    if (remaining <= 0 && !s.receipt_sent && s.email) {
      const subject = 'Your City Park Parking Receipt';
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">management</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><p>Your parking session has ended. Here is your receipt.</p><table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:20px;"><tr><td style="color:#888;font-size:13px;">Ticket</td><td style="font-weight:700;">${s.id}</td></tr><tr><td style="color:#888;font-size:13px;">Plate</td><td style="font-weight:700;">${s.plate}</td></tr><tr><td style="color:#888;font-size:13px;">Duration</td><td style="font-weight:700;">${s.duration}hr</td></tr><tr><td style="color:#888;font-size:13px;">Amount Paid</td><td style="font-weight:700;color:#2e7d32;">$${s.paid.toFixed(2)}</td></tr></table><p style="font-size:13px;color:#888;">Thank you for parking with City Park Management.</p></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Management LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;
      await sendEmail(s.email, subject, html);
      await supabase.from('sessions').update({ receipt_sent: true }).eq('id', s.id);
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});