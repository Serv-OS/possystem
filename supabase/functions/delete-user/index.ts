// supabase/functions/delete-user/index.ts
//
// 5.11.123 (30 Oct 2026): ServOS (super admin) removes a Back Office login for good.
// Body: { userId } or { email }. Deletes the auth user; the database cascades user_profiles and
// user_locations (both ON DELETE CASCADE). Refuses: a caller who is not super_admin, the caller's
// own login, another super_admin, an anonymous user (those are kiosk and online sessions, not
// logins). WHY: Admin had no way to remove a login, and deleting a company removed the profile
// rows but left the auth login behind (mickey at Next Flavour Kitchens, made 30 Jul, orphaned),
// which then blocked "add user" as "already exists". Admin's company delete now calls this too.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { findAuthUserByEmail } from '../_shared/authUserLookup.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md

  const url = Deno.env.get('SUPABASE_URL') ?? '', serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);
  const { data: callerProfile } = await admin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle();
  if (callerProfile?.role !== 'super_admin') return json({ error: 'Only ServOS can remove a login' }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  let userId: string | null = typeof body.userId === 'string' && UUID.test(body.userId) ? body.userId : null;
  if (!userId && body.email) {
    const found = await findAuthUserByEmail({ supabaseUrl: url, serviceKey, email: String(body.email), listUsers: (a: any) => admin.auth.admin.listUsers(a) });
    userId = found?.id ?? null;
  }
  if (!userId) return json({ error: 'No login with that email' }, 404);
  if (userId === caller.id) return json({ error: 'You cannot remove your own login' }, 400);

  const { data: target, error: getErr } = await admin.auth.admin.getUserById(userId);
  if (getErr || !target?.user) return json({ error: 'No such login' }, 404);
  if (target.user.is_anonymous) return json({ error: 'That is an anonymous session, not a login' }, 400);
  const { data: targetProfile } = await admin.from('user_profiles').select('role, email').eq('id', userId).maybeSingle();
  if (targetProfile?.role === 'super_admin') return json({ error: 'That login belongs to a platform administrator' }, 403);

  // auth.users -> user_profiles -> user_locations, both ON DELETE CASCADE. One delete.
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) return json({ error: `Could not remove the login: ${delErr.message}` }, 500);
  console.log(JSON.stringify({ fn: 'delete-user', by: caller.id, removed: userId, hadProfile: !!targetProfile }));
  return json({ success: true, userId, email: target.user.email ?? targetProfile?.email ?? null });
});
