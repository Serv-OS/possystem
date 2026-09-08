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
    const isSuper = profile?.role === 'super_admin';

    let { email, password, fullName, orgId, locationId, role } = await req.json();

    // v5.6.7 — a venue OWNER or MANAGER may grant Back Office access to THEIR
    // OWN venue (Peter, 7 Aug: "as an admin of that location I should be able
    // to add someone else"). This was super_admin-only. The relaxation is
    // deliberately narrow, because this function can also MODIFY existing
    // users, which is where the privilege escalation lives:
    //   - the venue is the caller's own (user_locations row), never from the body
    //   - orgId is resolved server-side from that venue, never trusted
    //   - the granted role is capped at the caller's own rank, never super_admin
    //   - an existing user's PROFILE is never rewritten by a non-super caller —
    //     they only gain a user_locations row for this one venue (rewriting
    //     org_id/role on an arbitrary email would let a venue manager hijack
    //     or downgrade any account on the platform, including a super_admin's)
    const RANK: Record<string, number> = { manager: 1, owner: 2 };
    let callerRank = 0;
    if (!isSuper) {
      if (!locationId) return new Response(JSON.stringify({ error: 'Pick a location — venue admins grant access per venue' }), { status: 400, headers: corsHeaders });
      const { data: ul } = await supabaseAdmin.from('user_locations')
        .select('role').eq('user_id', caller.id).eq('location_id', locationId).maybeSingle();
      callerRank = RANK[String(ul?.role || '').toLowerCase()] || 0;
      if (!callerRank) return new Response(JSON.stringify({ error: 'Only an owner or manager of this venue can grant Back Office access' }), { status: 403, headers: corsHeaders });
      const { data: locRow } = await supabaseAdmin.from('locations').select('org_id').eq('id', locationId).maybeSingle();
      if (!locRow) return new Response(JSON.stringify({ error: 'Unknown location' }), { status: 400, headers: corsHeaders });
      orgId = locRow.org_id;                                  // server truth, not the body
      const wanted = String(role || 'manager').toLowerCase();
      role = (RANK[wanted] && RANK[wanted] <= callerRank) ? wanted : 'manager';
    }

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

    if (alreadyExisted && !isSuper) {
      // The email already has an account. A venue admin may grant that account
      // access to THIS venue, but never rewrite its profile — and never touch
      // a platform admin's account at all.
      const { data: target } = await supabaseAdmin.from('user_profiles').select('role').eq('id', userId).maybeSingle();
      if (target?.role === 'super_admin') {
        return new Response(JSON.stringify({ error: 'That email belongs to a platform administrator' }), { status: 403, headers: corsHeaders });
      }
      await supabaseAdmin.from('user_locations')
        .upsert({ user_id: userId, location_id: locationId, role: role || 'manager' },
                { onConflict: 'user_id,location_id' });
      return new Response(JSON.stringify({ success: true, userId, id: userId, email, alreadyExisted: true, note: 'Existing login — granted access to this venue; their password is unchanged' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
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

    return new Response(JSON.stringify({ success: true, userId, id: userId, email, alreadyExisted }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
