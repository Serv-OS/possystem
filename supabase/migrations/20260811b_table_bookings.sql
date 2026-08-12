-- ═══════════════════════════════════════════════════════════════════════════
-- Table Bookings — Phase 1 data foundation (design handoff, adapted to the
-- conventions ACTUALLY in force Aug 2026 — waitlist 20260623t + wf_ style —
-- NOT the legacy supabase-schema.sql style the handoff's SCHEMA.sql followed).
--
-- Adaptations from the handoff, all deliberate:
--  · NO separate guests table — Peter's call (11 Aug): ONE unified CRM. The
--    existing org-scoped customers table gains the booking columns; bookings
--    link via customer_id FK + a denormalised customer jsonb snapshot (the
--    waitlist_entries precedent). Consent stays in customer_consents (audit
--    table, 6 existing writers) — no new consent flags.
--  · uuid location_id FK locations(id); gen_random_uuid ids server-side; the
--    app-minted text id pattern ONLY where the client needs optimistic ids
--    (bookings, packages — like waitlist_entries 'wl-…').
--  · Member tables never get a DB/status column on active_sessions or
--    floor_tables (neither has status at all; six writers re-derive status
--    from session presence). booking_tables IS the joined-tables truth; the
--    floor derives the dashed outline + blocking from live bookings.
--  · create_booking RPC = the OPTIMISER.md race-closer: conflict check and
--    insert are atomic under a per-location advisory lock, so two host
--    stands can never book the same table for the same window.
--  · RLS: operational tables match their POS-core peers (tills are anon
--    today — active_sessions/table_reservations posture; tighten with the
--    programme-wide RLS work, tracked in PRE_STAGE_READINESS). Money
--    (booking_payments) is BO-read + service-role-write ONLY from day one.
--    booking_requests (public widget intake) has NO direct-access policies —
--    serverless/service-role only.
--
-- Idempotent + re-runnable. Apply to Ops DB (tbetcegmszzotrwdtqhi).
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- ── 0. Unified CRM: booking columns on customers ───────────────────────────
alter table public.customers add column if not exists tags text[] default '{}';
alter table public.customers add column if not exists no_shows integer not null default 0;
alter table public.customers add column if not exists shopper_reference text;
alter table public.customers add column if not exists stored_payment_method_id text;

comment on column public.customers.tags is 'Operator labels shown at booking + on the check: VIP, window seat, etc. Allergens have their own column.';
comment on column public.customers.no_shows is 'Lifetime no-show count across the org — drives the card-hold prompt at booking.';
comment on column public.customers.shopper_reference is 'Adyen shopperReference (we use the customer uuid). Set once, never re-keyed.';
comment on column public.customers.stored_payment_method_id is 'Adyen stored payment method (card on file) for holds/no-show capture.';

-- ── touch helper (module-prefixed, per convention) ─────────────────────────
create or replace function public.bk_touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ── 1. Bookings ────────────────────────────────────────────────────────────
create table if not exists public.bookings (
  id text primary key,                       -- app-minted 'bk-<ts>-<rand>' (optimistic UI)
  location_id uuid not null references public.locations(id) on delete cascade,
  org_id uuid,
  customer_id uuid references public.customers(id) on delete set null,
  customer jsonb,                            -- denormalised snapshot {name, phone, allergens, tags} — survives CRM edits/deletes
  booking_date date not null,
  start_time time not null,
  turn_minutes integer not null check (turn_minutes between 15 and 720),
  covers integer not null check (covers between 1 and 200),
  primary_table_id text not null,            -- the ONLY table that opens an active_session
  status text not null default 'confirmed'
    check (status in ('confirmed','prepaid','due','late','dining','departed','cancelled','no_show')),
  source text not null default 'host'
    check (source in ('host','phone','widget','walk_in','events','pos')),
  package_id text,                           -- soft ref → packages(id); FK added below, guarded
  note text not null default '',             -- occasion/access needs; prints on host stand + KDS
  pacing_override_by text,                   -- manager name/PIN-holder when booked past the pacing cap (Peter: PIN-gated)
  seated_session_ref text,                   -- informational ORD-ref; NEVER a key (client counters are not unique)
  seated_at timestamptz,
  departed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 2. Booking ↔ table membership (the joined-tables truth) ────────────────
create table if not exists public.booking_tables (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  booking_id text not null references public.bookings(id) on delete cascade,
  table_id text not null,                    -- floor_tables.id is text — soft ref by convention
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (booking_id, table_id)
);

-- ── 3. Packages & events ───────────────────────────────────────────────────
create table if not exists public.packages (
  id text primary key,                       -- app-minted 'pk-…' (lives in the config push snapshot)
  location_id uuid not null references public.locations(id) on delete cascade,
  org_id uuid,
  name text not null,
  description text not null default '',
  price numeric(10,2) not null default 0,
  price_unit text not null default 'per_cover'
    check (price_unit in ('per_cover','per_booking','minimum_spend')),
  payment_model text not null default 'deposit'
    check (payment_model in ('hold','deposit','prepay')),
  deposit_per_cover numeric(10,2) not null default 0,
  turn_minutes integer,                      -- overrides the cover-band turn entirely
  available_from date,
  available_to date,
  available_days integer[] not null default '{}',   -- 0=Sun … 6=Sat
  available_start time,
  available_end time,
  min_covers integer not null default 1,
  max_covers integer,
  max_per_service integer,                   -- e.g. only 2 tasting menus a night
  sections text[] not null default '{}',
  requires_preorder boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.bookings
    add constraint bookings_package_fk foreign key (package_id)
    references public.packages(id) on delete set null;
exception when duplicate_object then null; end $$;

-- What the package becomes on the POS check. course = menu_categories.default_course ints.
create table if not exists public.package_lines (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  package_id text not null references public.packages(id) on delete cascade,
  item_id text,                              -- menu_items.id; null = non-menu line
  display_name text not null,
  qty_per_cover numeric(6,2) not null default 1,
  course integer not null default 0 check (course between 0 and 3),
  price_override numeric(10,2),              -- null = inherit, 0 = included in package price
  is_preorder_choice boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Per-guest pre-order choices taken at booking time.
create table if not exists public.booking_preorders (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  booking_id text not null references public.bookings(id) on delete cascade,
  seat integer,
  guest_name text,
  item_id text,
  display_name text,
  course integer not null default 0 check (course between 0 and 3),
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- ── 4. Payments (Phase 5 lands the flows; the ledger exists from day one) ──
create table if not exists public.booking_payments (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  booking_id text not null references public.bookings(id) on delete cascade,
  kind text not null check (kind in ('hold','deposit','prepay','no_show_charge','refund')),
  amount numeric(10,2) not null default 0,
  currency text not null default 'gbp',
  status text not null default 'pending'
    check (status in ('pending','authorised','captured','cancelled','failed','refunded')),
  -- 'pending' is NORMAL: Adyen confirms by async webhook; the booking is
  -- written and the table held before the authorisation result is known.
  psp_reference text,                        -- Adyen pspReference — webhook idempotency key
  merchant_reference text,
  merchant_account text,
  stored_payment_method_id text,
  card_last4 text,
  card_brand text,
  refusal_reason text,
  applied_to_check boolean not null default false,   -- true once posted as a TENDER line
  authorised_at timestamptz,
  captured_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── 5. Rules (one row per location; join_groups authored in FloorPlanBuilder)
create table if not exists public.booking_rules (
  location_id uuid primary key references public.locations(id) on delete cascade,
  org_id uuid,
  turn_1_2 integer not null default 90,
  turn_3_4 integer not null default 105,
  turn_5_6 integer not null default 120,
  turn_7_plus integer not null default 150,
  max_join integer not null default 3 check (max_join between 1 and 4),
  waste_tolerance integer not null default 2 check (waste_tolerance between 0 and 6),
  pacing_cap integer not null default 12 check (pacing_cap between 2 and 30),
  protect_large_tables boolean not null default true,
  pacing_override_requires_pin boolean not null default true,  -- Peter 11 Aug: manager PIN to book past the cap
  hold_per_cover numeric(10,2) not null default 20,
  cancellation_window_hours integer not null default 24,
  deposit_threshold_covers integer not null default 6,
  service_start time not null default '17:00',
  service_end time not null default '23:00',
  slot_minutes integer not null default 15,
  join_groups jsonb not null default '[]',   -- [{id,label,tableIds:[…],kind}] — ORDER = adjacency
  widget_enabled boolean not null default true,
  widget_max_days_ahead integer not null default 90,
  card_capture_enabled boolean not null default false,  -- payments ship DARK per venue
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 6. Widget intake (public writes land here and NOWHERE else) ────────────
create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  booking_id text references public.bookings(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── triggers ───────────────────────────────────────────────────────────────
drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings
  for each row execute function public.bk_touch_updated_at();
drop trigger if exists packages_touch on public.packages;
create trigger packages_touch before update on public.packages
  for each row execute function public.bk_touch_updated_at();
drop trigger if exists booking_rules_touch on public.booking_rules;
create trigger booking_rules_touch before update on public.booking_rules
  for each row execute function public.bk_touch_updated_at();

-- ── indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_bookings_loc_date on public.bookings(location_id, booking_date, start_time);
create index if not exists idx_bookings_customer on public.bookings(customer_id);
create index if not exists idx_bookings_loc_status on public.bookings(location_id, status);
create index if not exists idx_booking_tables_booking on public.booking_tables(booking_id);
create index if not exists idx_booking_tables_loc_table on public.booking_tables(location_id, table_id);
create index if not exists idx_packages_loc on public.packages(location_id, is_active);
create index if not exists idx_package_lines_pkg on public.package_lines(package_id, sort_order);
create index if not exists idx_booking_payments_booking on public.booking_payments(booking_id);
create unique index if not exists idx_booking_payments_psp on public.booking_payments(psp_reference) where psp_reference is not null;
create index if not exists idx_booking_preorders_booking on public.booking_preorders(booking_id);
create index if not exists idx_booking_requests_loc on public.booking_requests(location_id, status, created_at desc);

-- ── 7. create_booking — the atomic write that closes the double-book race ──
-- OPTIMISER.md: "Re-run the free check inside the write transaction and reject
-- with a clear message." Serialised per location by an advisory xact lock, so
-- two devices offered the same candidate cannot both win.
create or replace function public.create_booking(
  p_id text,
  p_location_id uuid,
  p_booking_date date,
  p_start_time time,
  p_turn_minutes integer,
  p_covers integer,
  p_table_ids text[],
  p_primary_table_id text,
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_status text default 'confirmed',
  p_source text default 'host',
  p_package_id text default null,
  p_note text default '',
  p_created_by text default null,
  p_pacing_override_by text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conflict record;
  v_org uuid;
  v_start_min int := extract(hour from p_start_time)::int * 60 + extract(minute from p_start_time)::int;
  v_end_min int := v_start_min + p_turn_minutes;
begin
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;

  -- serialise booking writes for this venue
  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  -- the free check, inside the transaction: any live booking overlapping the
  -- half-open window on any requested table wins.
  select b.id, b.customer->>'name' as name, bt.table_id into v_conflict
  from bookings b
  join booking_tables bt on bt.booking_id = b.id
  where b.location_id = p_location_id
    and b.booking_date = p_booking_date
    and b.status not in ('departed','cancelled','no_show')
    and bt.table_id = any(p_table_ids)
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end_min
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start_min
  limit 1;

  if found then
    return jsonb_build_object('ok', false, 'error', 'table_taken',
      'table_id', v_conflict.table_id, 'booking_id', v_conflict.id);
  end if;

  select org_id into v_org from locations where id = p_location_id;

  insert into bookings (id, location_id, org_id, customer_id, customer, booking_date, start_time,
    turn_minutes, covers, primary_table_id, status, source, package_id, note, created_by, pacing_override_by)
  values (p_id, p_location_id, v_org, p_customer_id, p_customer, p_booking_date, p_start_time,
    p_turn_minutes, p_covers, p_primary_table_id, coalesce(p_status,'confirmed'),
    coalesce(p_source,'host'), p_package_id, coalesce(p_note,''), p_created_by, p_pacing_override_by);

  insert into booking_tables (location_id, booking_id, table_id, is_primary)
  select p_location_id, p_id, t, (t = p_primary_table_id) from unnest(p_table_ids) as t;

  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

revoke all on function public.create_booking(text, uuid, date, time, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text) from public;
grant execute on function public.create_booking(text, uuid, date, time, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text) to anon, authenticated;

-- ── 8. RLS ─────────────────────────────────────────────────────────────────
alter table public.bookings          enable row level security;
alter table public.booking_tables    enable row level security;
alter table public.packages          enable row level security;
alter table public.package_lines     enable row level security;
alter table public.booking_preorders enable row level security;
alter table public.booking_payments  enable row level security;
alter table public.booking_rules     enable row level security;
alter table public.booking_requests  enable row level security;

-- Operational tables: match the POS-core posture (anon tills read/write
-- active_sessions + table_reservations today). Tighten alongside the
-- programme-wide RLS work — tracked in PRE_STAGE_READINESS.
do $$ begin
  create policy "allow all" on public.bookings          for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow all" on public.booking_tables    for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow all" on public.packages          for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow all" on public.package_lines     for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow all" on public.booking_preorders for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow all" on public.booking_rules     for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Money: BO-read only; ALL writes via service-role (edge fns/webhook).
revoke all on public.booking_payments from anon, authenticated;
do $$ begin
  create policy "bo read" on public.booking_payments for select
    using (location_id::text in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
grant select on public.booking_payments to authenticated;

-- Widget intake: NO direct-access policies at all — the serverless endpoint
-- writes with service_role. The public never touches this table directly.
revoke all on public.booking_requests from anon, authenticated;

-- ── 9. Realtime (publish ONLY what the live boards subscribe to) ───────────
alter table public.bookings       replica identity full;  -- DELETE payloads must carry location_id for the client guard
alter table public.booking_tables replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='bookings') then
    alter publication supabase_realtime add table public.bookings;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='booking_tables') then
    alter publication supabase_realtime add table public.booking_tables;
  end if;
end $$;

commit;
