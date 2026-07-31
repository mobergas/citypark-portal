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

function wrapEmail(innerHtml: string) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);"><tr><td style="background:#0d0d0d;padding:24px 32px;border-bottom:5px solid #b5d96e;"><img src="https://sldahhdbvcxdlqdhmsjd.supabase.co/storage/v1/object/public/assets/Logo%201.png" alt="City Park Management" style="height:48px;display:block;"></td></tr><tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#444;">${innerHtml}</td></tr><tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">City Park Holdings LLC · info@cityparkmanagement.com</td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const { type, id, email } = await req.json();
    if (!email || !email.includes('@')) throw new Error('Valid email required');

    if (type === 'session') {
      const { data: s } = await supabase.from('sessions').select('*').eq('id', id).single();
      if (!s) throw new Error('Session not found');
      const { data: lot } = await supabase.from('lots').select('*').eq('id', s.lot_id).single();
      const dur = s.rate === 'hourly' ? s.duration + 'hr' : s.rate === 'event' ? 'Event' : 'Monthly';
      const start = new Date(s.start_time);
      const exp = new Date(s.start_time + s.duration * 3600000);
      const html = wrapEmail(`<h2 style="font-size:20px;font-weight:900;margin:0 0 4px;color:#0d0d0d;">Parking Receipt</h2><p style="margin:0 0 20px;font-size:13px;color:#888;">Here is a copy of your receipt.</p><table width="100%" cellpadding="10" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:20px;"><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Ticket #</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${s.id}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Plate</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${s.plate}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Location</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${lot?.name||'—'}${lot?.zone?' · Zone '+lot.zone:''}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Started</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${start.toLocaleDateString()}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Ended</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${exp.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${exp.toLocaleDateString()}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Duration</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${dur}</td></tr><tr><td style="color:#888;font-size:13px;">Amount Paid</td><td style="font-weight:900;font-size:18px;color:#2e7d32;">$${s.paid.toFixed(2)}</td></tr></table>`);
      await sendEmail(email, 'Your City Park Parking Receipt', html);
    } else if (type === 'pass') {
      const { data: p } = await supabase.from('passes').select('*').eq('id', id).single();
      if (!p) throw new Error('Pass not found');
      const amount = p.custom_price || p.monthly_amount || 0;
      const html = wrapEmail(`<h2 style="font-size:20px;font-weight:900;margin:0 0 4px;color:#0d0d0d;">Monthly Pass Receipt</h2><p style="margin:0 0 20px;font-size:13px;color:#888;">Here is a copy of your monthly pass details.</p><table width="100%" cellpadding="10" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:20px;"><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Pass ID</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${p.id}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Name</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${p.holder_name||p.name}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Lot</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${p.lot_name||'—'}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Plate</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${p.plate||'—'}</td></tr><tr><td style="color:#888;font-size:13px;">Monthly Rate</td><td style="font-weight:900;font-size:18px;color:#2e7d32;">${amount>0?'$'+amount.toFixed(2):'FREE'}</td></tr></table>`);
      await sendEmail(email, 'Your City Park Monthly Pass Receipt', html);
    } else if (type === 'violation') {
      const { data: v } = await supabase.from('violations').select('*').eq('id', id).single();
      if (!v) throw new Error('Violation not found');
      const html = wrapEmail(`<h2 style="font-size:20px;font-weight:900;margin:0 0 4px;color:#0d0d0d;">Violation Payment Receipt</h2><p style="margin:0 0 20px;font-size:13px;color:#888;">${v.status==='paid'?'Thank you for your payment.':'This violation is currently unpaid.'}</p><table width="100%" cellpadding="10" cellspacing="0" style="background:#f5f5f5;border-radius:8px;margin-bottom:20px;"><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Violation ID</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${v.id}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Plate</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${v.plate}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Location</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${v.lot_name||'—'}</td></tr><tr><td style="color:#888;font-size:13px;border-bottom:1px solid #e0e0e0">Violation</td><td style="font-weight:700;border-bottom:1px solid #e0e0e0">${v.violation_name||'—'}</td></tr><tr><td style="color:#888;font-size:13px;">${v.status==='paid'?'Amount Paid':'Amount Due'}</td><td style="font-weight:900;font-size:18px;color:${v.status==='paid'?'#2e7d32':'#d32f2f'};">$${v.fine_amount.toFixed(2)}</td></tr></table>`);
      await sendEmail(email, `Parking Violation Receipt - ${v.id}`, html);
    } else {
      throw new Error('Invalid type');
    }

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});