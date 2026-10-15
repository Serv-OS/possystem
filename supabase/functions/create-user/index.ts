import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
// Back Office section access (8 Oct 2026): the same rules file the web app reads, so the
// list of sections and the "never more than the creator" rule cannot drift apart.
import { allowedKeys, isEverythingRole, planLoginSections, sameSections, storedSections, isSectionsColumnMissing } from '../_shared/boSectionRules.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md

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

    // BACK OFFICE SECTION ACCESS (Peter, 8 Oct 2026: "limit what they can see via each tab").
    // user_profiles.bo_sections says which parts of Back Office a login is shown: null =
    // everything, a list = only those. It is a SCREEN lock, not a database lock. This function
    // is one of the only two things that write it (the other is public.set_bo_sections), and it
    // holds one rule above all: a login made by a limited person never opens more than that
    // person does. So the caller's own list is read here, with the service role, never taken
    // from the request.
    // The column is new. "It does not exist" means the database update has not run: then
    // nobody is limited and logins are made exactly as before. Any OTHER failure reading the
    // caller means we do not know their limit, so nothing is created.
    let sectionsInstalled = true;
    let callerRead: any = await supabaseAdmin.from('user_profiles').select('role, org_id, bo_sections').eq('id', caller.id).single();
    if (callerRead.error && isSectionsColumnMissing(callerRead.error)) {
      sectionsInstalled = false;
      callerRead = await supabaseAdmin.from('user_profiles').select('role, org_id').eq('id', caller.id).single();
    }
    if (callerRead.error || !callerRead.data) {
      return new Response(JSON.stringify({ error: 'Could not check your access. Try again.' }), { status: 403, headers: corsHeaders });
    }
    const profile = callerRead.data;
    const isSuper = profile?.role === 'super_admin';
    // What the caller may open: null = everything (an owner, ServOS staff, or no list set).
    const callerSections = sectionsInstalled ? allowedKeys({ role: profile.role, sections: profile.bo_sections }) : null;
    const callerLimited = callerSections !== null;

    let { email, password, fullName, orgId, locationId, role, sections: askedSections } = await req.json();

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
      // 8 Oct 2026: a limited caller only ever makes a manager. An owner opens everything
      // whatever list it holds, so a limited login holding an owner link at the venue could
      // otherwise make itself an unlimited owner with one request.
      if (callerLimited) role = 'manager';
    }

    if (!email || !password || !orgId) return new Response(JSON.stringify({ error: 'email, password and orgId required' }), { status: 400, headers: corsHeaders });

    // The list this login should have, decided BEFORE anything is created: a wrong key, or a
    // limited caller asking only for parts they do not have, stops here with nothing made.
    const loginRole = String(role || 'owner');
    const plan = planLoginSections({ asked: askedSections, callerSections, role: loginRole });
    if (!plan.ok) return new Response(JSON.stringify({ error: plan.error }), { status: plan.status, headers: corsHeaders });
    const wantSections: string[] | null = plan.sections;   // null = everything

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
      const { data: target }: any = await supabaseAdmin.from('user_profiles')
        .select(sectionsInstalled ? 'role, org_id, bo_sections' : 'role, org_id').eq('id', userId).maybeSingle();
      if (target?.role === 'super_admin') {
        return new Response(JSON.stringify({ error: 'That email belongs to a platform administrator' }), { status: 403, headers: corsHeaders });
      }
      // 8 Oct 2026: an existing login keeps its own list, which may be everything. A limited
      // caller linking one to their venue would hand out more than they have themselves (they
      // could sign up a second account and link it), so that is the owner's job.
      if (callerLimited) {
        return new Response(JSON.stringify({ error: 'That email already has a login. Ask the owner to add it to this venue.' }), { status: 403, headers: corsHeaders });
      }
      // What that login opens today. Unknown (no profile row) stays unknown, never "everything".
      let nowSections: string[] | null | undefined = !target ? undefined
        : (isEverythingRole(target.role) || !sectionsInstalled) ? null : storedSections(target.bo_sections);
      if (wantSections !== null) {
        // The caller asked for a LIMITED login and this email already has one. The limit is set
        // FIRST, under the same rule as public.set_bo_sections (an owner of the same company,
        // never on an owner's login), and if it cannot be set the venue link is NOT made:
        // linking a login that opens everything, while the screen says "limited", is the one
        // thing that must not happen.
        const callerIsOwner = profile.role === 'owner' && !!profile.org_id && profile.org_id === orgId;
        const canLimit = sectionsInstalled && callerIsOwner && !!target && target.org_id === orgId && !isEverythingRole(target.role);
        if (!canLimit) {
          return new Response(JSON.stringify({ error: 'That email already has a login, and it cannot be limited here. Nothing was changed.' }), { status: 403, headers: corsHeaders });
        }
        const { data: wrote, error: limitErr } = await supabaseAdmin.from('user_profiles')
          .update({ bo_sections: wantSections }).eq('id', userId).select('id');
        if (limitErr || !wrote?.length) {
          return new Response(JSON.stringify({ error: 'Could not save what this login can open. Nothing was changed.' }), { status: 500, headers: corsHeaders });
        }
        nowSections = wantSections;
      }
      await supabaseAdmin.from('user_locations')
        .upsert({ user_id: userId, location_id: locationId, role: role || 'manager' },
                { onConflict: 'user_id,location_id' });
      // sections = what this login can open NOW (null = everything). sectionsApplied = that is
      // what this call decided. The Team screen shows `sections`, never what it asked for.
      return new Response(JSON.stringify({ success: true, userId, id: userId, email, alreadyExisted: true, note: 'Existing login — granted access to this venue; their password is unchanged', sectionsApplied: sameSections(nowSections, wantSections), sections: nowSections, sectionsInstalled }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update their profile with org/location. v5.5.305: also write email —
    // the handle_new_user trigger now copies it, but set it explicitly here
    // too so the profile is fully populated regardless of trigger state.
    // 8 Oct 2026: this write is CHECKED now. A new profile starts as role 'owner' (the
    // sign up trigger writes that), and an owner opens everything whatever list it holds, so a
    // write that silently failed left a "manager" who was really an unlimited owner. If the
    // role did not land, stop BEFORE the venue link: a login with no link reaches no venue.
    const { data: savedProfile, error: profileErr } = await supabaseAdmin.from('user_profiles').update({
      email,
      org_id: orgId,
      location_id: locationId || null,
      role: role || 'owner',
      full_name: fullName || email,
    }).eq('id', userId).select('id, role');
    if (profileErr || !savedProfile?.length || savedProfile[0].role !== loginRole) {
      return new Response(JSON.stringify({ error: 'The login was made, but its profile could not be saved, so it has no access yet. Try again.', userId }), { status: 500, headers: corsHeaders });
    }

    // The list, in its own write so a database without the column still makes the login.
    //   a list                         always written;
    //   null on a brand new login      nothing to write (the column starts null);
    //   null on an existing login      written only to CLEAR an old list: it is becoming an
    //                                  owner, or the caller (ServOS here) asked for everything.
    // Column missing = the database update has not run: carry on and say so in the answer.
    // Any other failure with a list wanted stops before the venue link, as above.
    const clearOld = alreadyExisted && (isEverythingRole(loginRole) || askedSections !== undefined);
    if (sectionsInstalled && (wantSections !== null || clearOld)) {
      const { error: sectionsErr } = await supabaseAdmin.from('user_profiles').update({ bo_sections: wantSections }).eq('id', userId);
      if (sectionsErr && isSectionsColumnMissing(sectionsErr)) {
        sectionsInstalled = false;
      } else if (sectionsErr) {
        return new Response(JSON.stringify({ error: 'The login was made, but what it can open could not be saved, so it has no access yet. Try again.', userId }), { status: 500, headers: corsHeaders });
      }
    }
    // Read back what is stored: the answer says what the login can open NOW, not what was asked.
    let nowSections: string[] | null | undefined = null;   // not installed, or an owner: everything
    if (sectionsInstalled && !isEverythingRole(loginRole)) {
      const { data: back, error: backErr }: any = await supabaseAdmin.from('user_profiles').select('bo_sections').eq('id', userId).maybeSingle();
      if (backErr && isSectionsColumnMissing(backErr)) sectionsInstalled = false;
      else nowSections = backErr || !back ? undefined : storedSections(back.bo_sections);
      if (sectionsInstalled && wantSections !== null && !sameSections(nowSections, wantSections)) {
        return new Response(JSON.stringify({ error: 'The login was made, but what it can open could not be saved, so it has no access yet. Try again.', userId }), { status: 500, headers: corsHeaders });
      }
    }

    // v5.5.305: also create a user_locations row so the user appears in the
    // location's access list and resolves via the junction table on login.
    if (locationId) {
      await supabaseAdmin.from('user_locations')
        .upsert({ user_id: userId, location_id: locationId, role: role || 'owner' },
                { onConflict: 'user_id,location_id' });
    }

    // sections = what this login can open NOW (null = everything). sectionsApplied = that is
    // what this call decided. An answer WITHOUT sectionsApplied comes from the older function,
    // which knows nothing about lists: the Team screen treats that as "not limited".
    return new Response(JSON.stringify({ success: true, userId, id: userId, email, alreadyExisted, sectionsApplied: sameSections(nowSections, wantSections), sections: nowSections, sectionsInstalled }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
