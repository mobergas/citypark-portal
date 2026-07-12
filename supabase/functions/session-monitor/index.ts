import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function sendEmail(to: string, subject: string, html: string, attachments?: any[]) {
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}` },
    body: JSON.stringify({ to, subject, html, attachments })
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

async function createStripePaymentLink(amount: number, description: string, invoiceId: string) {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
  const priceBody = new URLSearchParams({
    'unit_amount': Math.round(amount * 100).toString(),
    'currency': 'usd',
    'product_data[name]': description,
  });
  const priceRes = await fetch('https://api.stripe.com/v1/prices', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: priceBody.toString(),
  });
  const price = await priceRes.json();
  if (!priceRes.ok) throw new Error(price.error?.message || 'Failed to create price');

  const linkBody = new URLSearchParams({
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    'metadata[invoiceId]': invoiceId,
    'metadata[type]': 'validation_invoice',
  });
  const linkRes = await fetch('https://api.stripe.com/v1/payment_links', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: linkBody.toString(),
  });
  const link = await linkRes.json();
  if (!linkRes.ok) throw new Error(link.error?.message || 'Failed to create payment link');
  return { url: link.url, id: link.id };
}

function buildMonthlyReceiptEmail(pass: any, amount: number, nextBillDate: Date) {
  const nextBillStr = nextBillDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">holdings</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><p>Hi ${pass.holder_name||pass.name},</p><p style="margin-top:12px">Your monthly parking pass has been renewed.</p><table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin:20px 0;"><tr><td style="color:#888;font-size:13px;">Pass ID</td><td style="font-weight:700;">${pass.id}</td></tr><tr><td style="color:#888;font-size:13px;">Lot</td><td style="font-weight:700;">${pass.lot_name||'—'}</td></tr><tr><td style="color:#888;font-size:13px;">Plate</td><td style="font-weight:700;">${pass.plate||'—'}</td></tr><tr><td style="color:#888;font-size:13px;">Amount Charged</td><td style="font-weight:700;color:#2e7d32;">$${amount.toFixed(2)}</td></tr><tr><td style="color:#888;font-size:13px;">Next Bill Date</td><td style="font-weight:700;">${nextBillStr}</td></tr></table></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async () => {
  const now = Date.now();
  const tenMinMs = 10 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isFirstOfMonth = today.getDate() === 1;

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
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">holdings</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><p>Your parking session has ended. Here is your receipt.</p><table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:20px;"><tr><td style="color:#888;font-size:13px;">Ticket</td><td style="font-weight:700;">${s.id}</td></tr><tr><td style="color:#888;font-size:13px;">Plate</td><td style="font-weight:700;">${s.plate}</td></tr><tr><td style="color:#888;font-size:13px;">Duration</td><td style="font-weight:700;">${s.duration}hr</td></tr><tr><td style="color:#888;font-size:13px;">Amount Paid</td><td style="font-weight:700;color:#2e7d32;">$${s.paid.toFixed(2)}</td></tr></table></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;
      await sendEmail(s.email, subject, html);
      await supabase.from('sessions').update({ receipt_sent: true }).eq('id', s.id);
    }
  }

  // Monthly pass auto-billing
  const { data: passes } = await supabase.from('passes').select('*').eq('status', 'active');

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
        const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        await supabase.from('passes').update({
          next_bill_date: next.toISOString(),
          total_billed: (pass.total_billed || 0) + amount
        }).eq('id', pass.id);
        if (pass.email) {
          const html = buildMonthlyReceiptEmail(pass, amount, next);
          await sendEmail(pass.email, 'Your City Park Monthly Pass Receipt', html);
        }
      } catch(e) {
        console.error('Monthly billing error for', pass.id, e);
      }
    }
  }

  // Auto-generate validation invoices on the 1st of each month
  if (isFirstOfMonth) {
    const { data: validations } = await supabase
      .from('validations')
      .select('*')
      .not('billing_email', 'is', null)
      .gt('monthly_rate', 0);

    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const periodStart = lastMonth.toLocaleDateString('en-US');
    const periodEnd = lastMonthEnd.toLocaleDateString('en-US');

    for (const val of validations || []) {
      try {
        // Check for duplicate invoice
        const { data: existing } = await supabase
          .from('invoices')
          .select('id')
          .eq('validation_id', val.id)
          .eq('period_start', periodStart);

        if (existing && existing.length > 0) {
          console.log('Invoice already exists for', val.id, periodStart);
          continue;
        }

        // Get sessions for last month
        const { data: sessionsForVal } = await supabase
          .from('sessions')
          .select('*')
          .eq('val_id', val.id)
          .gte('start_time', lastMonth.getTime())
          .lte('start_time', lastMonthEnd.getTime() + 86400000);

        const sessions = (sessionsForVal || []).map((s: any) => ({
          id: s.id,
          date: new Date(s.start_time).toLocaleDateString(),
          plate: s.plate,
          type: s.type,
          discount: Math.max(0, (s.pkch || s.paid) - s.paid + (s.sfee || 0))
        }));

        const amount = val.billing_method === 'actual'
          ? sessions.reduce((a: number, s: any) => a + s.discount, 0)
          : val.monthly_rate;

        if (amount <= 0) continue;

        const invoiceId = 'INV-' + Date.now() + '-' + val.id.slice(-4);
        const description = `Parking Validation Invoice - ${val.name} - ${periodStart} to ${periodEnd}`;
        const { url: paymentLink, id: paymentLinkId } = await createStripePaymentLink(amount, description, invoiceId);

        await supabase.from('invoices').insert({
          id: invoiceId,
          validation_id: val.id,
          period_start: periodStart,
          period_end: periodEnd,
          sessions_count: sessions.length,
          total_discount: sessions.reduce((a: number, s: any) => a + s.discount, 0),
          amount_due: amount,
          status: 'unpaid',
          stripe_payment_link: paymentLink,
          stripe_payment_link_id: paymentLinkId,
        });

        // Build CSV
        const csvRows = [
          ['Date', 'Ticket ID', 'Plate', 'Type', 'Discount Given'],
          ...sessions.map((s: any) => [s.date, s.id, s.plate, s.type, `$${s.discount.toFixed(2)}`]),
          [],
          ['', '', '', 'TOTAL DISCOUNT', `$${sessions.reduce((a: number, s: any) => a + s.discount, 0).toFixed(2)}`],
          ['', '', '', 'AMOUNT DUE', `$${amount.toFixed(2)}`],
        ];
        const csv = csvRows.map(r => r.map((c: any) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
        const csvBase64 = btoa(unescape(encodeURIComponent(csv)));

        const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
                <tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;">
                  <span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span>
                  <span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">holdings</span>
                </td></tr>
                <tr><td style="padding:32px;">
                  <h2 style="font-size:24px;margin-bottom:4px;">Monthly Parking Validation Invoice</h2>
                  <p style="color:#888;font-size:13px;margin-bottom:24px;">Invoice #${invoiceId} · Auto-generated</p>
                  <table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:24px;">
                    <tr><td style="color:#888;font-size:13px;">Bill To</td><td style="font-weight:700;">${val.billing_contact||val.name}</td></tr>
                    <tr><td style="color:#888;font-size:13px;">Validation</td><td style="font-weight:700;">${val.name}</td></tr>
                    <tr><td style="color:#888;font-size:13px;">Period</td><td style="font-weight:700;">${periodStart} – ${periodEnd}</td></tr>
                    <tr><td style="color:#888;font-size:13px;">Sessions</td><td style="font-weight:700;">${sessions.length}</td></tr>
                    <tr><td style="color:#888;font-size:13px;">Amount Due</td><td style="font-weight:700;font-size:18px;color:#2e7d32;">$${amount.toFixed(2)}</td></tr>
                  </table>
                  <p style="font-size:13px;color:#666;margin-bottom:24px;">Session details are attached as a CSV file.</p>
                  <div style="text-align:center;margin:28px 0;">
                    <a href="${paymentLink}" style="background:#b5d96e;color:#0d0d0d;font-weight:900;font-size:16px;padding:16px 32px;border-radius:10px;text-decoration:none;display:inline-block;text-transform:uppercase;">Pay Now — $${amount.toFixed(2)}</a>
                  </div>
                  <p style="font-size:13px;color:#888;">Questions? Contact us at <a href="mailto:info@cityparkmanagement.com">info@cityparkmanagement.com</a></p>
                </td></tr>
                <tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr>
              </table>
            </td></tr>
          </table>
        </body></html>`;

        const attachments = [{
          filename: `Invoice_${val.name.replace(/\s+/g,'_')}_${periodStart.replace(/\//g,'-')}_to_${periodEnd.replace(/\//g,'-')}.csv`,
          content: csvBase64,
        }];

        await sendEmail(val.billing_email, `Monthly Invoice - ${val.name} - ${periodStart} to ${periodEnd}`, html, attachments);
        console.log('Auto-invoice sent for', val.name, invoiceId);

      } catch(e) {
        console.error('Auto-invoice error for', val.id, e);
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});