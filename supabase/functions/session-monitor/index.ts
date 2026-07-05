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

async function chargeMonthlyPass(pass: any) {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
  const amount = pass.custom_price || pass.monthly_amount;
  
  const body = new URLSearchParams({
    amount: Math.round(amount * 100).toString(),
    currency: 'usd',
    customer: pass.stripe_customer_id,
    payment_method: pass.stripe_payment_method_id,
    description: `Monthly parking pass - ${pass.lot_name||'Lot'} - ${pass.holder_name||pass.name}`,
    confirm: 'true',
    off_session: 'true',
  });

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(stripeKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  return res.json();
}

function buildReceiptEmail(pass: any, amount: number, nextBillDate: Date) {
  const nextBillStr = nextBillDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">management</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><p>Hi ${pass.holder_name||pass.name},</p><p style="margin-top:12px">Your monthly parking pass has been renewed. Here is your receipt.</p><table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin:20px 0;"><tr><td style="color:#888;font-size:13px;">Pass ID</td><td style="font-weight:700;">${pass.id}</td></tr><tr><td style="color:#888;font-size:13px;">Lot</td><td style="font-weight:700;">${pass.lot_name||'—'}</td></tr><tr><td style="color:#888;font-size:13px;">Plate</td><td style="font-weight:700;">${pass.plate||'—'}</td></tr><tr><td style="color:#888;font-size:13px;">Amount Charged</td><td style="font-weight:700;color:#2e7d32;">$${amount.toFixed(2)}</td></tr><tr><td style="color:#888;font-size:13px;">Next Bill Date</td><td style="font-weight:700;">${nextBillStr}</td></tr></table><p style="font-size:13px;color:#888;">Thank you for being a City Park monthly pass holder.</p></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Management LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async () => {
  const now = Date.now();
  const tenMinMs = 10 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Load sessions
  const { data: sessions } = await supabase.from('sessions').select('*');

  for (const s of sessions || []) {
    const start = new Date(s.start_time).getTime();
    const expiry = start + s.duration * 3600000;
    const remaining = expiry - now;

    // Auto-capture uncaptured payments older than 10 minutes
    if(s.payment_intent_id && !s.captured && (now - start) > tenMinMs && s.paid > 0){
      try {
        const result = await capturePaymentIntent(s.payment_intent_id, s.paid);
        if(!result.error){
          await supabase.from('sessions').update({ captured: true }).eq('id', s.id);
        } else {
          console.error('Capture error for', s.id, result.error);
        }
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

  // Monthly pass auto-billing
  const { data: passes } = await supabase
    .from('passes')
    .select('*')
    .eq('status', 'active');

  for (const pass of passes || []) {
    if (!pass.next_bill_date || !pass.stripe_customer_id || !pass.stripe_payment_method_id) continue;
    
    const nextBill = new Date(pass.next_bill_date);
    nextBill.setHours(0, 0, 0, 0);
    
    if (nextBill.getTime() <= today.getTime()) {
      try {
        const amount = pass.custom_price || pass.monthly_amount;
        const result = await chargeMonthlyPass(pass);
        
        if (result.error) {
          console.error('Monthly charge failed for', pass.id, result.error);
          await supabase.from('passes').update({ status: 'past_due' }).eq('id', pass.id);
          continue;
        }

        // Set next bill date to 1st of next month
        const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        await supabase.from('passes').update({
          next_bill_date: next.toISOString(),
          total_billed: (pass.total_billed || 0) + amount
        }).eq('id', pass.id);

        // Send receipt email
        if (pass.email) {
          const html = buildReceiptEmail(pass, amount, next);
          await sendEmail(pass.email, 'Your City Park Monthly Pass Receipt', html);
        }

      } catch(e) {
        console.error('Monthly billing error for', pass.id, e);
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});