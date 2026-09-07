import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Twilio signs against the public webhook URL configured in its console. Supabase's edge
// gateway rewrites req.url internally (strips /functions/v1, forces http), so that can't
// be used directly — the real public URL has to be hardcoded here instead.
const WEBHOOK_URL = 'https://sldahhdbvcxdlqdhmsjd.supabase.co/functions/v1/receive-sms';

function twiml(message: string) {
  const escaped = message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

// Twilio signs each webhook request with HMAC-SHA1 over the exact request URL plus
// every POST param (sorted by key, concatenated as key+value with no separator),
// keyed with the account's auth token. See: twilio.com/docs/usage/webhooks/webhooks-security
async function computeTwilioSignature(url: string, params: Record<string, string>, authToken: string) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

Deno.serve(async (req) => {
  try {
    const formData = await req.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of formData.entries()) params[k] = String(v);

    const signature = req.headers.get('x-twilio-signature') || '';
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!;
    const computed = await computeTwilioSignature(WEBHOOK_URL, params, authToken);
    if (computed !== signature) {
      return new Response(twiml('Unauthorized'), { status: 403, headers: { 'Content-Type': 'text/xml' } });
    }

    const body = (formData.get('Body') as string || '').trim();
    const zone = body.replace(/\D/g, ''); // keep only digits

    const { data: lots } = await supabase.from('lots').select('*').eq('zone', zone);
    const lot = lots && lots.length ? lots[0] : null;

    let reply: string;
    if (lot) {
      const link = `https://www.cityparkmanagement.app/pay?lot=${lot.id}&zone=${lot.zone}`;
      reply = `City Park Management: Pay for parking at ${lot.name} (Zone ${lot.zone}) here: ${link}`;
    } else {
      reply = `City Park Management: We couldn't find that zone number. Please double check the number posted at your parking spot and try again, or visit cityparkmanagement.app to pay directly.`;
    }

    return new Response(twiml(reply), {
      headers: { 'Content-Type': 'text/xml' }
    });
  } catch (err) {
    return new Response(twiml('City Park Management: Something went wrong. Please visit cityparkmanagement.app to pay directly.'), {
      headers: { 'Content-Type': 'text/xml' }
    });
  }
});