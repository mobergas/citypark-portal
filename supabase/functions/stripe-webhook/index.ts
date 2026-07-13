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
    const body = await req.text();
    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const paymentIntent = event.data?.object;
    if (!paymentIntent) return new Response('OK', { status: 200 });

    if (event.type === 'payment_intent.payment_failed') {
      console.log('Payment failed:', paymentIntent.id);
      const customerId = paymentIntent.customer;
      if (customerId) {
        const { data: passes } = await supabase
          .from('passes')
          .select('*')
          .eq('stripe_customer_id', customerId)
          .eq('status', 'active');

        for (const pass of passes || []) {
          await supabase.from('passes').update({ status: 'past_due' }).eq('id', pass.id);
          await sendEmail(
            'info@cityparkmanagement.com',
            `⚠️ Monthly Pass Payment Failed - ${pass.holder_name || pass.name}`,
            `<p>Payment failed for ${pass.holder_name || pass.name} (${pass.email}). Pass marked as past_due. Stripe PI: ${paymentIntent.id}</p>`
          );
          if (pass.email) {
            // Generate card update token
            const updateToken = 'cu_' + crypto.randomUUID().replace(/-/g,'').slice(0,16);
            await supabase.from('passes').update({ card_update_token: updateToken }).eq('id', pass.id);
            const updateLink = `https://cityparkmanagement.app/update-card?token=${updateToken}`;
            
            await sendEmail(
              pass.email,
              'Action Required: Monthly Parking Pass Payment Failed',
              `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #d32f2f;"><span style="font-weight:900;font-size:22px;color:#ffffff;">city park</span><span style="font-weight:900;font-size:11px;color:#b5d96e;letter-spacing:0.12em;text-transform:uppercase;display:block;margin-top:2px;">holdings</span></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;"><h2 style="color:#d32f2f;margin-bottom:8px;">Payment Failed</h2><p>Hi ${pass.holder_name || pass.name},</p><p style="margin-top:12px">We were unable to process your monthly parking pass payment of <strong>$${(pass.custom_price || pass.monthly_amount || 0).toFixed(2)}</strong> for <strong>${pass.lot_name || 'your lot'}</strong>.</p><p style="margin-top:12px">Please update your payment method to keep your parking spot.</p><div style="text-align:center;margin:28px 0;"><a href="${updateLink}" style="background:#d32f2f;color:#fff;font-weight:900;font-size:16px;padding:16px 32px;border-radius:10px;text-decoration:none;display:inline-block;text-transform:uppercase;">Update Payment Method</a></div><p style="font-size:13px;color:#888;">If you have questions, contact us at <a href="mailto:info@cityparkmanagement.com">info@cityparkmanagement.com</a></p></td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`
            );
          }
        }
      }
    }

    if (event.type === 'checkout.session.completed') {
      // Handle payment link completions
      const session = event.data.object;
      const invoiceId = session.metadata?.invoiceId;
      const type = session.metadata?.type;

      if (type === 'validation_invoice' && invoiceId) {
        console.log('Invoice paid:', invoiceId);
        const amountPaid = session.amount_total / 100;

        await supabase.from('invoices').update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        }).eq('id', invoiceId);

        // Get invoice details for revenue tracking
        const { data: invoices } = await supabase
          .from('invoices')
          .select('*')
          .eq('id', invoiceId);

        const invoice = invoices?.[0];
        if (invoice) {
          // Add to revenue as a session-like record
          await supabase.from('invoice_payments').insert({
            id: 'INVP-' + Date.now(),
            invoice_id: invoiceId,
            validation_id: invoice.validation_id,
            amount: amountPaid,
            paid_at: new Date().toISOString(),
          }).catch(() => {}); // table may not exist yet

          // Notify admin
          await sendEmail(
            'info@cityparkmanagement.com',
            `✅ Invoice Paid - ${invoiceId}`,
            `<p>Invoice ${invoiceId} has been paid. Amount: $${amountPaid.toFixed(2)}</p>`
          );
        }
      }
    }

    if (event.type === 'payment_intent.succeeded') {
      console.log('Payment succeeded:', paymentIntent.id);
      
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
      
      // Get checkout session ID from payment details
      const checkoutSessionId = paymentIntent.payment_details?.order_reference;
      console.log('Checkout session ID:', checkoutSessionId);
      
      if(checkoutSessionId){
        // Look up checkout session to get payment link
        const csRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${checkoutSessionId}`, {
          headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':') }
        });
        const csData = await csRes.json();
        const paymentLinkId = csData.payment_link;
        console.log('Payment link ID:', paymentLinkId);
        
        if(paymentLinkId){
          const { data: invoices } = await supabase
            .from('invoices')
            .select('*')
            .eq('stripe_payment_link_id', paymentLinkId)
            .eq('status', 'unpaid');
          
          const invoice = invoices?.[0];
          if(invoice){
            await supabase.from('invoices').update({
              status: 'paid',
              paid_at: new Date().toISOString(),
            }).eq('id', invoice.id);

            await sendEmail(
              'info@cityparkmanagement.com',
              `✅ Invoice Paid - ${invoice.id}`,
              `<p>Invoice ${invoice.id} has been paid. Amount: $${(paymentIntent.amount/100).toFixed(2)}</p>`
            );
            console.log('Invoice marked paid:', invoice.id);
          }
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});