import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Use service_role key — this is safe because it runs server-side in Supabase
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify the caller is a super_admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });

    const { data: { user: caller } } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!caller) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: corsHeaders });

    const { data: profile } = await supabaseAdmin.from('user_profiles').select('role').eq('id', caller.id).single();
    if (profile?.role !== 'super_admin') return new Response(JSON.stringify({ error: 'Requires super_admin' }), { status: 403, headers: corsHeaders });

    // Create the new user
    const { email, password, fullName, orgId, locationId, role } = await req.json();
    if (!email || !password || !orgId) return new Response(JSON.stringify({ error: 'email, password and orgId required' }), { status: 400, headers: corsHeaders });

    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip confirmation email
      user_metadata: { full_name: fullName || email, role: role || 'owner' },
    });

    // v5.5.320: make this idempotent. If the email already exists, don't error
    // out and leave a half-populated profile — find the existing auth user and
    // STILL apply the org/location/role/email profile update + user_locations
    // link below. A re-invite (typo retry, double-click, re-provision) then
    // repairs the user instead of failing.
    let userId = newUser?.user?.id || null;
    let alreadyExisted = false;
    if (createErr) {
      const dup = /already.*registered|already.*exists|duplicate/i.test(createErr.message || '');
      if (!dup) {
        return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers: corsHeaders });
      }
      // Look up the existing auth user by email (paginate defensively).
      try {
        let page = 1;
        while (page <= 20 && !userId) {
          const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
          const match = (list?.users || []).find((u: any) => (u.email || '').toLowerCase() === String(email).toLowerCase());
          if (match) { userId = match.id; alreadyExisted = true; break; }
          if (!list || (list.users || []).length < 200) break;
          page++;
        }
      } catch (e) { /* fall through to error below if still unresolved */ }
      if (!userId) {
        return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers: corsHeaders });
      }
    }

    // Update their profile with org/location. v5.5.305: also write email —
    // the handle_new_user trigger now copies it, but set it explicitly here
    // too so the profile is fully populated regardless of trigger state.
    await supabaseAdmin.from('user_profiles').update({
      email,
      org_id: orgId,
      location_id: locationId || null,
      role: role || 'owner',
      full_name: fullName || email,
    }).eq('id', userId);

    // v5.5.305: also create a user_locations row so the user appears in the
    // location's access list and resolves via the junction table on login.
    if (locationId) {
      await supabaseAdmin.from('user_locations')
        .upsert({ user_id: userId, location_id: locationId, role: role || 'owner' },
                { onConflict: 'user_id,location_id' });
    }

    return new Response(JSON.stringify({ success: true, userId, email, alreadyExisted }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
