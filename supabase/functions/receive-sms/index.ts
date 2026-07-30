import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

function twiml(message: string) {
  const escaped = message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

Deno.serve(async (req) => {
  try {
    const formData = await req.formData();
    const body = (formData.get('Body') as string || '').trim();
    const zone = body.replace(/\D/g, ''); // keep only digits

    const { data: lots } = await supabase.from('lots').select('*').eq('zone', zone);
    const lot = lots && lots.length ? lots[0] : null;

    let reply: string;
    if (lot) {
      const link = `https://cityparkmanagement.app/pay?lot=${lot.id}&zone=${lot.zone}`;
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