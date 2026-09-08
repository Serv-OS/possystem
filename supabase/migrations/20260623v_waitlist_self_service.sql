-- 20260623v_waitlist_self_service.sql
-- Tables Ready — guest self-service (QR/web join + live status page).
-- Additive + reversible. The whole guest path goes through SECURITY DEFINER RPCs granted to anon,
-- because waitlist_entries RLS is waitlist_can_write() (BO OR claimed device) — a guest has neither.
-- A guest can ONLY: join (when the venue opted in AND a host stand is live), read THEIR OWN status by
-- an unguessable token, and cancel/confirm their own entry. No RPC ever returns another guest's PII.
--
-- Mirrors catering_public_settings (security definer, returns only when enabled) and the 20260623t
-- conventions (gen_random_uuid for codes — pgcrypto's gen_random_bytes is NOT on this search_path).

-- ── opt-in flag + the guest's private token ───────────────────────────────────
alter table public.waitlist_config
  add column if not exists self_service_enabled boolean not null default false;

alter table public.waitlist_entries
  add column if not exists public_token text;
create unique index if not exists waitlist_entries_token_idx
  on public.waitlist_entries (public_token) where public_token is not null;

-- ── helpers ───────────────────────────────────────────────────────────────────
-- Server-side phone normaliser (ports src/lib/customerLookup.js normalisePhone; UK default +44).
create or replace function public.wl_normalise_phone(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '[^0-9+]', '', 'g');
  if d = '' then return null; end if;
  if left(d, 1) = '+' then return d; end if;
  if left(d, 2) = '07' and length(d) = 11 then return '+44' || substr(d, 2); end if;
  if left(d, 2) = '44' then return '+' || d; end if;
  return d;
end $$;

-- Band id (1=1-2, 2=3-4, 3=5-6, 4=7+) — matches DEFAULT_BANDS in src/lib/waitlist/waitlist.js, for
-- position-in-band on the guest status page.
create or replace function public.wl_band_id(p_size int)
returns int language sql immutable as $$
  select case when coalesce(p_size,1) <= 2 then 1
              when p_size <= 4 then 2
              when p_size <= 6 then 3
              else 4 end;
$$;

-- A venue accepts self-joins only if it opted in AND has a live (claimed, active) host stand.
create or replace function public._wl_self_open(p_location uuid)
returns boolean language sql stable security definer set search_path = public as $$
  -- 30-min liveness window: self-service is "open" only while a host stand is actually present
  -- (it heartbeats every ~60s). Closes promptly when the stand walks away — limits the unattended
  -- self-join window (anti-spam) and keeps quotes fresh.
  select coalesce((select self_service_enabled from waitlist_config where location_id = p_location), false)
     and exists (select 1 from waitlist_devices d
                 where d.location_id = p_location and d.active
                   and coalesce(d.last_seen_at, d.claimed_at) > now() - interval '30 minutes');
$$;
-- Internal helper: callable only by the SECURITY DEFINER RPCs below, not by anon directly.
revoke execute on function public._wl_self_open(uuid) from public;

-- ── public config: is self-service open here? (+ section options) ──────────────
-- Returns null when not open (client shows "not available"); never leaks anything sensitive.
create or replace function public.waitlist_public_config(p_location uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when public._wl_self_open(p_location)
    then jsonb_build_object('enabled', true, 'zones', coalesce((select zones from waitlist_config where location_id = p_location), '[]'::jsonb))
    else null end;
$$;

-- ── join the waitlist (anonymous guest) ───────────────────────────────────────
-- Re-checks the open gate server-side. De-dupes on phone (returns the existing token if the guest is
-- already active). Mints an unguessable token. Returns ONLY the token. Never auto-links the CRM (v1).
create or replace function public.waitlist_self_join(
  p_location uuid, p_name text, p_phone text, p_size int, p_notes text default null, p_zone text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_phone text; v_id text; v_token text; v_existing record;
begin
  if not public._wl_self_open(p_location) then
    raise exception 'self-service is not available at this venue right now';
  end if;
  v_phone := public.wl_normalise_phone(p_phone);
  if v_phone is null or length(v_phone) < 7 then raise exception 'a valid phone number is required'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'name is required'; end if;
  select org_id into v_org from locations where id = p_location;
  if v_org is null then raise exception 'venue not found'; end if;

  -- Anti-spam / SMS toll-fraud guards (this is an anonymous public endpoint):
  --  • per-venue burst cap, and
  --  • per-phone cool-down (a genuine re-show returns the existing token below, before this).
  if (select count(*) from waitlist_entries
        where location_id = p_location and added_at > now() - interval '10 minutes') >= 40 then
    raise exception 'too many sign-ups right now — please see the host';
  end if;
  if exists (select 1 from waitlist_entries
        where location_id = p_location and phone = v_phone and added_at > now() - interval '2 minutes') then
    raise exception 'you just signed up — check your status link';
  end if;

  -- Already on the list? Return their existing token (re-show status; don't create a duplicate).
  select id, public_token into v_existing from waitlist_entries
    where location_id = p_location and phone = v_phone
      and status in ('waiting','notified','ready')
    order by added_at desc limit 1;
  if found then
    if v_existing.public_token is null then
      v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
      update waitlist_entries set public_token = v_token where id = v_existing.id;
    else
      v_token := v_existing.public_token;
    end if;
    return jsonb_build_object('token', v_token, 'already', true);
  end if;

  v_id := 'wl-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
  v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into waitlist_entries (id, location_id, org_id, party_name, phone, party_size, status,
      section_pref, notes, source, public_token, customer, added_at)
    values (v_id, p_location, v_org, btrim(p_name), v_phone, greatest(1, coalesce(p_size,1)), 'waiting',
      nullif(btrim(coalesce(p_zone,'')), ''), nullif(btrim(coalesce(p_notes,'')), ''), 'self', v_token,
      jsonb_build_object('name', btrim(p_name), 'phone', v_phone, 'source', 'self'), now());
  insert into waitlist_status_events (location_id, waitlist_entry_id, from_status, to_status, actor)
    values (p_location, v_id, null, 'waiting', 'self');
  return jsonb_build_object('token', v_token, 'already', false);
end $$;

-- ── live status for one guest (by token only — unguessable) ───────────────────
-- Returns ONLY this guest's own fields + a position COUNT. No other guest's data is exposed.
create or replace function public.waitlist_self_status(p_token text)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare v record; v_pos int; v_quote int;
begin
  if p_token is null or length(p_token) < 16 then return jsonb_build_object('found', false); end if;
  -- Token is valid only for 12h after the guest joined — a leaked/bookmarked link can't read forever.
  select * into v from waitlist_entries where public_token = p_token and added_at > now() - interval '12 hours' limit 1;
  if not found then return jsonb_build_object('found', false); end if;
  -- position = active entries in the same band that arrived before this one.
  select count(*) into v_pos from waitlist_entries w
    where w.location_id = v.location_id
      and w.status in ('waiting','notified','ready')
      and w.added_at < v.added_at
      and public.wl_band_id(w.party_size) = public.wl_band_id(v.party_size);
  -- Quote fallback: until a live host board recomputes, show a sane per-band default (not "— min").
  v_quote := coalesce(v.quoted_wait_min,
    case public.wl_band_id(v.party_size) when 1 then 45 when 2 then 60 when 3 then 75 else 90 end);
  return jsonb_build_object(
    'found', true,
    'status', v.status,
    'party_name', v.party_name,
    'party_size', v.party_size,
    'quoted_wait_min', case when v.status in ('waiting','notified','ready') then v_quote else null end,
    'position', case when v.status in ('waiting','notified','ready') then v_pos + 1 else null end,
    'confirmed_at', v.confirmed_at,
    'added_at', v.added_at
  );
end $$;

-- ── guest action: on-my-way / cancel (by token) ───────────────────────────────
create or replace function public.waitlist_self_update(p_token text, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if p_token is null then return jsonb_build_object('ok', false); end if;
  -- 12h token TTL (same as status) — a stale/leaked link can't mutate an old entry.
  select * into v from waitlist_entries where public_token = p_token and added_at > now() - interval '12 hours' limit 1;
  if not found then return jsonb_build_object('ok', false); end if;

  if p_action = 'on_my_way' then
    if v.status in ('waiting','notified','ready') then
      update waitlist_entries set confirmed_at = now(), last_guest_reply = 'on_my_way', last_reply_at = now()
        where id = v.id;
    end if;
    return jsonb_build_object('ok', true, 'status', v.status, 'confirmed', v.status in ('waiting','notified','ready'));
  elsif p_action = 'cancel' then
    if v.status in ('waiting','notified','ready') then
      update waitlist_entries set status = 'cancelled', last_guest_reply = 'cancel', last_reply_at = now()
        where id = v.id;
      insert into waitlist_status_events (location_id, waitlist_entry_id, from_status, to_status, actor)
        values (v.location_id, v.id, v.status, 'cancelled', 'self');
      return jsonb_build_object('ok', true, 'status', 'cancelled');
    end if;
    -- No-op (already seated/cancelled/etc.) — return the TRUE status so the guest UI doesn't lie.
    return jsonb_build_object('ok', true, 'status', v.status);
  end if;
  return jsonb_build_object('ok', false, 'error', 'unknown action');
end $$;

-- ── grants (anonymous guests call these) ──────────────────────────────────────
grant execute on function public.wl_normalise_phone(text)                         to anon, authenticated;
grant execute on function public.wl_band_id(int)                                  to anon, authenticated;
grant execute on function public.waitlist_public_config(uuid)                     to anon, authenticated;
grant execute on function public.waitlist_self_join(uuid, text, text, int, text, text) to anon, authenticated;
grant execute on function public.waitlist_self_status(text)                       to anon, authenticated;
grant execute on function public.waitlist_self_update(text, text)                 to anon, authenticated;
-- _wl_self_open is an internal helper used by the SECURITY DEFINER RPCs above; no direct grant needed.
