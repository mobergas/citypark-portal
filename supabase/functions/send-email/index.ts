import { withCors } from '../_shared/cors.ts';
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://www.cityparkmanagement.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function isAuthorized(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (token && token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return true;
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  return !error && !!data?.user;
}

Deno.serve(withCors(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!(await isAuthorized(req))) {
    return new Response(JSON.stringify({ error: 'Not authorized' }), { status: 401, headers: corsHeaders });
  }

  try {
    const { to, subject, html, attachments, operatorId } = await req.json();

    const resendApiKey = Deno.env.get('RESEND_API_KEY');

    // The display name comes from the operators table by id, never from caller-supplied text,
    // so a caller can't set an arbitrary sender name. The address stays on our verified domain.
    let fromName = 'City Park Management';
    if (operatorId) {
      const { data: op } = await supabase.from('operators').select('name').eq('id', operatorId).maybeSingle();
      const clean = String(op?.name || '').replace(/[<>",\r\n]/g, '').trim();
      if (clean) fromName = clean;
    }

    const body: any = {
      from: `${fromName} <info@cityparkmanagement.com>`,
      to,
      subject,
      html,
    };

    if (attachments && attachments.length > 0) {
      body.attachments = attachments;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ error: data }), { 
        status: 400,
        headers: corsHeaders 
      });
    }

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: corsHeaders 
    });
  }
}));