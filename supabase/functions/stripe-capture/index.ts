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
    const { paymentIntentId, amount, cancel, originalAmount } = await req.json();
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!;

    let url = `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/capture`;
    const body = new URLSearchParams();

    if(cancel){
      url = `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/cancel`;
    } else if(amount !== undefined){
      body.set('amount_to_capture', Math.round(amount * 100).toString());
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(stripeKey + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      // If it was already captured (auto-captured before the validation code was applied),
      // fall back to a refund instead of failing outright.
      const alreadyCaptured = data.error?.message?.includes('already been captured') || data.error?.message?.includes('status of succeeded');
      console.log('DEBUG: cancel=', cancel, 'alreadyCaptured=', alreadyCaptured, 'errorMsg=', data.error?.message);

      // Full refund case: code made parking free, but payment was already captured
      if (alreadyCaptured && cancel) {
        const fullRefundRes = await fetch('https://api.stripe.com/v1/refunds', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(stripeKey + ':'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ payment_intent: paymentIntentId }).toString(),
        });
        const fullRefundData = await fullRefundRes.json();
        if (!fullRefundRes.ok) {
          return new Response(JSON.stringify({ error: fullRefundData.error?.message || 'Refund failed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        return new Response(JSON.stringify({ success: true, refunded: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Partial reduction case (amount specified but not zero)
      if (alreadyCaptured && !cancel && amount !== undefined && originalAmount !== undefined) {
        const targetAmount = Math.round(amount * 100);
        const originalAmountCents = Math.round(originalAmount * 100);
        const refundAmount = originalAmountCents - targetAmount;
        console.log('DEBUG: targetAmount=', targetAmount, 'originalAmountCents=', originalAmountCents, 'refundAmount=', refundAmount);

        if (refundAmount > 0) {
          const refundBody = new URLSearchParams({
            payment_intent: paymentIntentId,
            amount: refundAmount.toString(),
          });
          const refundRes = await fetch('https://api.stripe.com/v1/refunds', {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(stripeKey + ':'),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: refundBody.toString(),
          });
          const refundData = await refundRes.json();
          if (!refundRes.ok) {
            return new Response(JSON.stringify({ error: refundData.error?.message || 'Refund failed' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }
          return new Response(JSON.stringify({ success: true, refunded: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      return new Response(JSON.stringify({ error: data.error?.message || 'Stripe error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
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
