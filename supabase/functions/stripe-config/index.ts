// Serves the Stripe publishable key from the same place STRIPE_SECRET_KEY lives, instead
// of every client page hardcoding its own copy — so there's one source of truth to switch
// at go-live, not five+ files to hunt down and keep in sync by hand. Also actively checks
// that the two keys agree on test vs live before handing either out, which is the actual
// safeguard against a half-switched cutover that #25 asked for.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const publishableKey = Deno.env.get('STRIPE_PUBLISHABLE_KEY');
    const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!publishableKey || !secretKey) throw new Error('Stripe is not configured.');

    const pubMode = publishableKey.startsWith('pk_live_') ? 'live' : publishableKey.startsWith('pk_test_') ? 'test' : null;
    const secMode = secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : null;
    if (!pubMode || !secMode || pubMode !== secMode) {
      console.error('Stripe key mode mismatch — publishable:', pubMode, 'secret:', secMode);
      throw new Error('Stripe configuration error. Payments are temporarily unavailable — please contact support.');
    }

    return new Response(JSON.stringify({ publishableKey, mode: pubMode }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app' }
    });
  }
});
