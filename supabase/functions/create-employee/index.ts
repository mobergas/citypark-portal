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
      return new Response(JSON.stringify({ error: 'Only admins can create staff accounts' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const { email, password, name, role } = await req.json();
    if (!email || !password || !name || !role) throw new Error('Missing required fields');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (!['admin', 'manager', 'employee'].includes(role)) throw new Error('Invalid role');

    const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr) throw createErr;

    const { error: profileErr } = await supabase.from('profiles').insert({ id: newUser.user.id, name, role, active: true });
    if (profileErr) {
      await supabase.auth.admin.deleteUser(newUser.user.id);
      throw profileErr;
    }

    return new Response(JSON.stringify({ success: true, id: newUser.user.id }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});