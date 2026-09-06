import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function sendEmail(to: string, subject: string, html: string, attachments?: any[]) {
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
    body: JSON.stringify({ to, subject, html, attachments })
  });
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
    headers: {
      'Authorization': 'Basic ' + btoa(stripeKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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
    headers: {
      'Authorization': 'Basic ' + btoa(stripeKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: linkBody.toString(),
  });
  const link = await linkRes.json();
  if (!linkRes.ok) throw new Error(link.error?.message || 'Failed to create payment link');

  return { url: link.url, id: link.id };
}

function invoiceEmailHtml(opts: { invoiceId: string; billingContact: string; valName: string; periodStart: string; periodEnd: string; sessionCount: number; amount: number; paymentLink: string; sessionsNote: string; }) {
  const { invoiceId, billingContact, valName, periodStart, periodEnd, sessionCount, amount, paymentLink, sessionsNote } = opts;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;">
              <span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span>
              <span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">management</span>
            </td></tr>
            <tr><td style="padding:32px;">
              <h2 style="font-size:24px;margin-bottom:4px;">Parking Validation Invoice</h2>
              <p style="color:#888;font-size:13px;margin-bottom:24px;">Invoice #${invoiceId}</p>
              <table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:24px;">
                <tr><td style="color:#888;font-size:13px;">Bill To</td><td style="font-weight:700;">${billingContact}</td></tr>
                <tr><td style="color:#888;font-size:13px;">Validation</td><td style="font-weight:700;">${valName}</td></tr>
                <tr><td style="color:#888;font-size:13px;">Period</td><td style="font-weight:700;">${periodStart} – ${periodEnd}</td></tr>
                <tr><td style="color:#888;font-size:13px;">Sessions</td><td style="font-weight:700;">${sessionCount}</td></tr>
                <tr><td style="color:#888;font-size:13px;">Amount Due</td><td style="font-weight:700;font-size:18px;color:#2e7d32;">$${amount.toFixed(2)}</td></tr>
              </table>
              <h3 style="font-size:15px;margin-bottom:12px;">Session Details</h3>
              <p style="font-size:13px;color:#666;">${sessionsNote}</p>
              <div style="text-align:center;margin:28px 0;">
                <a href="${paymentLink}" style="background:#b5d96e;color:#0d0d0d;font-weight:900;font-size:16px;padding:16px 32px;border-radius:10px;text-decoration:none;display:inline-block;letter-spacing:.04em;text-transform:uppercase;">Pay Now — $${amount.toFixed(2)}</a>
              </div>
              <p style="font-size:13px;color:#888;">Questions? Contact us at <a href="mailto:info@cityparkmanagement.com">info@cityparkmanagement.com</a></p>
            </td></tr>
            <tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Management · info@cityparkmanagement.com</td></tr>
          </table>
        </td></tr>
      </table>
    </body></html>`;
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
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const { data: callerProfile } = await supabase.from('profiles').select('role').eq('id', userData.user.id).single();
    if (!callerProfile || !['admin', 'manager'].includes(callerProfile.role)) {
      return new Response(JSON.stringify({ error: 'Only managers and admins can send validation invoices' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const body = await req.json();

    if (body.action === 'resend') {
      // Re-send notice for an invoice that already exists — reuse its stored amount and
      // payment link rather than creating a new Stripe price/link/invoice row each time.
      const { invoiceId } = body;
      if (!invoiceId) throw new Error('Invoice ID required');
      const { data: inv, error: invErr } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (invErr || !inv) throw new Error('Invoice not found');
      const { data: val, error: valErr } = await supabase.from('validations').select('*').eq('id', inv.validation_id).single();
      if (valErr || !val || !val.billing_email) throw new Error('No billing email on file for this validation');

      const html = invoiceEmailHtml({
        invoiceId: inv.id,
        billingContact: val.billing_contact || val.name,
        valName: val.name,
        periodStart: inv.period_start || '',
        periodEnd: inv.period_end || '',
        sessionCount: inv.sessions_count || 0,
        amount: inv.amount_due,
        paymentLink: inv.stripe_payment_link,
        sessionsNote: 'A detailed breakdown was included with the original invoice email.',
      });
      await sendEmail(val.billing_email, `Parking Validation Invoice - ${val.name} - ${inv.period_start} to ${inv.period_end}`, html);

      return new Response(JSON.stringify({ success: true, invoiceId: inv.id, paymentLink: inv.stripe_payment_link }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Create + send a new invoice for a billing period. Recompute everything from trusted
    // server-side data — never trust a client-supplied amount, billing email, or session
    // list for something that generates a real Stripe charge.
    const { valId, periodStartMs, periodEndMs, periodStartLabel, periodEndLabel } = body;
    if (!valId || !Number.isFinite(periodStartMs) || !Number.isFinite(periodEndMs)) throw new Error('Missing required fields');

    const { data: val, error: valErr } = await supabase.from('validations').select('*').eq('id', valId).single();
    if (valErr || !val) throw new Error('Validation not found');
    if (!val.billing_email) throw new Error('This validation has no billing email on file');

    const { data: sessions, error: sessErr } = await supabase
      .from('sessions')
      .select('*')
      .eq('val_id', valId)
      .gte('start_time', periodStartMs)
      .lte('start_time', periodEndMs);
    if (sessErr) throw sessErr;
    const sess = sessions || [];

    const totalDiscount = val.dont_bill ? 0 : sess.reduce((a: number, s: any) => a + (s.disc || 0), 0);
    const amount = val.dont_bill ? 0 : (val.billing_method === 'actual' ? +totalDiscount.toFixed(2) : (val.monthly_rate || 0));
    if (amount <= 0) throw new Error('Amount due is $0. Nothing to invoice.');

    const valName = val.name;
    const billingEmail = val.billing_email;
    const billingContact = val.billing_contact || val.name;
    const periodStart = periodStartLabel || new Date(periodStartMs).toLocaleDateString();
    const periodEnd = periodEndLabel || new Date(periodEndMs).toLocaleDateString();

    const invoiceId = 'INV-' + Date.now();
    const description = `Parking Validation Invoice - ${valName} - ${periodStart} to ${periodEnd}`;
    const { url: paymentLink, id: paymentLinkId } = await createStripePaymentLink(amount, description, invoiceId);

    await supabase.from('invoices').insert({
      id: invoiceId,
      validation_id: valId,
      period_start: periodStart,
      period_end: periodEnd,
      sessions_count: sess.length,
      total_discount: totalDiscount,
      amount_due: amount,
      status: 'unpaid',
      stripe_payment_link: paymentLink,
      stripe_payment_link_id: paymentLinkId,
    });

    const html = invoiceEmailHtml({
      invoiceId, billingContact, valName, periodStart, periodEnd,
      sessionCount: sess.length, amount, paymentLink,
      sessionsNote: `A detailed breakdown of all ${sess.length} validated sessions is attached as a CSV file.`,
    });

    // Generate CSV attachment from the server-fetched sessions, not client input
    const csvRows = [
      ['Date', 'Ticket ID', 'Plate', 'Type', 'Discount Given'],
      ...sess.map((s: any) => [new Date(s.start_time).toLocaleDateString(), s.id, s.plate, s.type, `$${(s.pkch - s.paid + s.sfee).toFixed(2)}`]),
      [],
      ['', '', '', 'TOTAL DISCOUNT', `$${totalDiscount.toFixed(2)}`],
      ['', '', '', 'AMOUNT DUE', `$${amount.toFixed(2)}`],
    ];
    const csv = csvRows.map(r => r.map((c: any) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const csvBase64 = btoa(unescape(encodeURIComponent(csv)));
    const attachments = [{
      filename: `Invoice_${valName.replace(/\s+/g, '_')}_${periodStart.replace(/\//g, '-')}_to_${periodEnd.replace(/\//g, '-')}.csv`,
      content: csvBase64,
    }];

    await sendEmail(billingEmail, `Parking Validation Invoice - ${valName} - ${periodStart} to ${periodEnd}`, html, attachments);

    return new Response(JSON.stringify({ success: true, invoiceId, paymentLink }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});
