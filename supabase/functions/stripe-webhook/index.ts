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
  const signature = req.headers.get('stripe-signature');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;
  const body = await req.text();

  // Verify webhook signature
  const verifyRes = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
    headers: { 'Authorization': 'Basic ' + btoa(stripeKey + ':') }
  });

  // Parse the event
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const paymentIntent = event.data?.object;
  if (!paymentIntent) return new Response('OK', { status: 200 });

  const sessionId = paymentIntent.metadata?.sessionId;

  if (event.type === 'payment_intent.payment_failed') {
    console.log('Payment failed:', paymentIntent.id, 'sessionId:', sessionId);

    // Find the pass with this payment method and mark as past_due
    const customerId = paymentIntent.customer;
    if (customerId) {
      const { data: passes } = await supabase
        .from('passes')
        .select('*')
        .eq('stripe_customer_id', customerId)
        .eq('status', 'active');

      for (const pass of passes || []) {
        await supabase.from('passes').update({ status: 'past_due' }).eq('id', pass.id);

        // Alert admin
        await sendEmail(
          'info@cityparkmanagement.com',
          `⚠️ Monthly Pass Payment Failed - ${pass.holder_name || pass.name}`,
          `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px;"><h2 style="color:#d32f2f">Payment Failed</h2><p>A monthly pass payment has failed.</p><table cellpadding="8" style="background:#f5f5f5;border-radius:8px;width:100%;"><tr><td><strong>Pass ID</strong></td><td>${pass.id}</td></tr><tr><td><strong>Name</strong></td><td>${pass.holder_name || pass.name}</td></tr><tr><td><strong>Email</strong></td><td>${pass.email}</td></tr><tr><td><strong>Lot</strong></td><td>${pass.lot_name || '—'}</td></tr><tr><td><strong>Amount</strong></td><td>$${(pass.custom_price || pass.monthly_amount || 0).toFixed(2)}</td></tr><tr><td><strong>Stripe PI</strong></td><td>${paymentIntent.id}</td></tr><tr><td><strong>Failure Reason</strong></td><td>${paymentIntent.last_payment_error?.message || 'Unknown'}</td></tr></table><p style="margin-top:16px">The pass has been marked as <strong>Past Due</strong>. Please follow up with the customer.</p><p style="color:#888;font-size:12px;">City Park Management LLC</p></body></html>`
        );

        // Notify customer
        if (pass.email) {
          await sendEmail(
            pass.email,
            'Action Required: Monthly Parking Pass Payment Failed',
            `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px;"><h2>Payment Issue with Your Parking Pass</h2><p>Hi ${pass.holder_name || pass.name},</p><p>We were unable to process your monthly parking pass payment of <strong>$${(pass.custom_price || pass.monthly_amount || 0).toFixed(2)}</strong> for <strong>${pass.lot_name || 'your lot'}</strong>.</p><p>Please contact us at <a href="mailto:info@cityparkmanagement.com">info@cityparkmanagement.com</a> to update your payment method and avoid losing your parking spot.</p><p style="color:#888;font-size:12px;">City Park Management LLC</p></body></html>`
          );
        }
      }
    }
  }

  if (event.type === 'payment_intent.succeeded') {
    console.log('Payment succeeded:', paymentIntent.id);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
});