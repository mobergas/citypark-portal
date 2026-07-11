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
    const { valId, valName, billingEmail, billingContact, amount, sessions, periodStart, periodEnd } = await req.json();

    const invoiceId = 'INV-' + Date.now();
    const description = `Parking Validation Invoice - ${valName} - ${periodStart} to ${periodEnd}`;
    const { url: paymentLink, id: paymentLinkId } = await createStripePaymentLink(amount, description, invoiceId);

    await supabase.from('invoices').insert({
      id: invoiceId,
      validation_id: valId,
      period_start: periodStart,
      period_end: periodEnd,
      sessions_count: sessions.length,
      total_discount: sessions.reduce((a: number, s: any) => a + s.discount, 0),
      amount_due: amount,
      status: 'unpaid',
      stripe_payment_link: paymentLink,
      stripe_payment_link_id: paymentLinkId,
    });

    const sessionsTable = `<p style="font-size:13px;color:#666;">A detailed breakdown of all ${sessions.length} validated sessions is attached as a CSV file.</p>`;

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
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
                <tr><td style="color:#888;font-size:13px;">Sessions</td><td style="font-weight:700;">${sessions.length}</td></tr>
                <tr><td style="color:#888;font-size:13px;">Amount Due</td><td style="font-weight:700;font-size:18px;color:#2e7d32;">$${amount.toFixed(2)}</td></tr>
              </table>
              <h3 style="font-size:15px;margin-bottom:12px;">Session Details</h3>
              ${sessionsTable}
              <div style="text-align:center;margin:28px 0;">
                <a href="${paymentLink}" style="background:#b5d96e;color:#0d0d0d;font-weight:900;font-size:16px;padding:16px 32px;border-radius:10px;text-decoration:none;display:inline-block;letter-spacing:.04em;text-transform:uppercase;">Pay Now — $${amount.toFixed(2)}</a>
              </div>
              <p style="font-size:13px;color:#888;">Questions? Contact us at <a href="mailto:info@cityparkmanagement.com">info@cityparkmanagement.com</a></p>
            </td></tr>
            <tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr>
          </table>
        </td></tr>
      </table>
    </body></html>`;

    // Generate CSV attachment
    const csvRows = [
      ['Date', 'Ticket ID', 'Plate', 'Type', 'Discount Given'],
      ...sessions.map((s: any) => [s.date, s.id, s.plate, s.type, `$${s.discount.toFixed(2)}`]),
      [],
      ['', '', '', 'TOTAL DISCOUNT', `$${sessions.reduce((a: number, s: any) => a + s.discount, 0).toFixed(2)}`],
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