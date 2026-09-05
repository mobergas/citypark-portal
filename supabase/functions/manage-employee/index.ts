import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
    });
  }

  try {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const { data: callerProfile } = await supabase.from('profiles').select('role').eq('id', userData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Only admins can manage staff accounts' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const { action, employeeId, email } = await req.json();
    if (!employeeId) throw new Error('Employee ID required');

    if (action === 'get_email') {
      const { data, error } = await supabase.auth.admin.getUserById(employeeId);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, email: data.user?.email || '' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (action === 'update_email') {
      if (!email || !email.includes('@')) throw new Error('Valid email required');
      const { error } = await supabase.auth.admin.updateUserById(employeeId, { email, email_confirm: true });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (action === 'send_reset') {
      const { data, error } = await supabase.auth.admin.getUserById(employeeId);
      if (error) throw error;
      const targetEmail = data.user?.email;
      if (!targetEmail) throw new Error('This account has no email on file');
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: 'https://cityparkmanagement.app/admin'
      });
      if (resetErr) throw resetErr;
      return new Response(JSON.stringify({ success: true, email: targetEmail }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    throw new Error('Invalid action');
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});
