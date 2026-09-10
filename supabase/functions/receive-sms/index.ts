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

// Keyed by the last 10 digits so it matches regardless of how a number is formatted
// elsewhere (+1 prefix, punctuation, etc.) — see the same normalization in send-sms.
function normalizePhone(p: string) {
  const digits = p.replace(/\D/g, '');
  return digits.slice(-10);
}

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const START_KEYWORDS = ['START', 'UNSTOP', 'YES'];
const HELP_KEYWORDS = ['HELP', 'INFO'];

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
    const from = (formData.get('From') as string || '').trim();
    const keyword = body.toUpperCase();

    // Twilio's own carrier-level Advanced Opt-Out can intercept STOP/START/HELP before this
    // webhook ever sees them, depending on how the number is configured — but the SMS terms
    // promise this behavior unconditionally, so it can't only work when that's turned on.
    // sms_optouts is checked by send-sms before every future send, regardless of which path
    // (Twilio's own filter or this one) actually caught the keyword.
    if (from && STOP_KEYWORDS.includes(keyword)) {
      await supabase.from('sms_optouts').upsert({ phone: normalizePhone(from) });
      return new Response(twiml('City Park Management: You have been unsubscribed and will not receive further texts. Reply START to resubscribe.'), {
        headers: { 'Content-Type': 'text/xml' }
      });
    }
    if (from && START_KEYWORDS.includes(keyword)) {
      await supabase.from('sms_optouts').delete().eq('phone', normalizePhone(from));
      return new Response(twiml('City Park Management: You are resubscribed to parking alerts and receipts. Reply STOP to opt out again at any time.'), {
        headers: { 'Content-Type': 'text/xml' }
      });
    }
    if (HELP_KEYWORDS.includes(keyword)) {
      return new Response(twiml('City Park Management: Parking alerts & receipts. Msg & data rates may apply. Reply STOP to opt out. Support: info@cityparkmanagement.com'), {
        headers: { 'Content-Type': 'text/xml' }
      });
    }

    const zone = body.replace(/\D/g, ''); // keep only digits

    // Match the client's own open/closed semantics (missing/null "open" counts as open) —
    // a SQL neq('open', false) filter would incorrectly exclude that null case.
    const { data: lots } = await supabase.from('lots').select('*').eq('zone', zone);
    const lot = (lots || []).find((l: any) => l.open !== false) || null;

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