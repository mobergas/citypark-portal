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

async function capturePaymentIntent(paymentIntentId: string, amount: number) {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
  const body = new URLSearchParams();
  body.set('amount_to_capture', Math.round(amount * 100).toString());
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(stripeKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  return res.json();
}

Deno.serve(async () => {
  const now = Date.now();
  const tenMinMs = 10 * 60 * 1000;

  const { data: sessions } = await supabase
    .from('sessions')
    .select('*');

  for (const s of sessions || []) {
    const start = new Date(s.start_time).getTime();
    const expiry = start + s.duration * 3600000;
    const remaining = expiry - now;

    // Auto-capture uncaptured payments older than 10 minutes
    if(s.payment_intent_id && !s.captured && (now - start) > tenMinMs && s.paid > 0){
      try {
        await capturePaymentIntent(s.payment_intent_id, s.paid);
        await supabase.from('sessions').update({ captured: true }).eq('id', s.id);
      } catch(e) {
        console.error('Capture failed for', s.id, e);
      }
    }

    // Send receipt email when session expires
    if (remaining <= 0 && !s.receipt_sent && s.email) {
      const subject = 'Your City Park Parking Receipt';
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">management</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><p>Your parking session has ended. Here is your receipt.</p><table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:20px;"><tr><td style="color:#888;font-size:13px;">Ticket</td><td style="font-weight:700;">${s.id}</td></tr><tr><td style="color:#888;font-size:13px;">Plate</td><td style="font-weight:700;">${s.plate}</td></tr><tr><td style="color:#888;font-size:13px;">Duration</td><td style="font-weight:700;">${s.duration}hr</td></tr><tr><td style="color:#888;font-size:13px;">Amount Paid</td><td style="font-weight:700;color:#2e7d32;">$${s.paid.toFixed(2)}</td></tr></table><p style="font-size:13px;color:#888;">Thank you for parking with City Park Management.</p></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Management LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;
      await sendEmail(s.email, subject, html);
      await supabase.from('sessions').update({ receipt_sent: true }).eq('id', s.id);
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});