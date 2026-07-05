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
    const { paymentMethodId, email, name, amount, description } = await req.json();
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;

    // Create Stripe customer
    const custBody = new URLSearchParams({ email, name });
    const custRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(stripeKey + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: custBody.toString(),
    });
    const customer = await custRes.json();
    if (!custRes.ok) throw new Error(customer.error?.message || 'Failed to create customer');

    // Attach payment method to customer
    const attachBody = new URLSearchParams({ customer: customer.id });
    await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(stripeKey + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: attachBody.toString(),
    });

    // Charge prorated first month
    const piBody = new URLSearchParams({
      amount: Math.round(amount * 100).toString(),
      currency: 'usd',
      customer: customer.id,
      payment_method: paymentMethodId,
      description,
      confirm: 'true',
      off_session: 'true',
    });
    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(stripeKey + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: piBody.toString(),
    });
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message || 'Failed to charge card');

    return new Response(JSON.stringify({
      customerId: customer.id,
      paymentMethodId,
      success: true
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});