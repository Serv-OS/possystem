// src/staff/seed.js
//
// Hospitality Staff Management — seed data (demo group), ported from the
// companion wireframe. Seed-first build: the whole UI + engines run on this so
// every screen is clickable; Supabase persistence + server-side pay compute are
// a later hardening pass. POS-sourced numbers (sales, clock-ins, tip pool) wire
// to the POS when this is connected to a real venue.
//
// Spec data model lives in claude-code-handoff/Master Build Spec.md §2.

// Week shown in the rota (Mon→Sun). TODAY = index of "today".
export const DAYS = [['Mon', '8'], ['Tue', '9'], ['Wed', '10'], ['Thu', '11'], ['Fri', '12'], ['Sat', '13'], ['Sun', '14']];
export const TODAY = 0;

export const SECTIONS = { bar: 'Bar', floor: 'Floor', kitchen: 'Kitchen', door: 'Door' };

// ── Venues (the demo group) ─────────────────────────────────────────────────
export const VENUES = [
  { id: 'anchor',  name: 'The Anchor',   type: 'pub',        labourTargetPct: 0.28 },
  { id: 'lumiere', name: 'Lumière',      type: 'restaurant', labourTargetPct: 0.30 },
  { id: 'beanbar', name: 'Bean & Bar',   type: 'cafe',       labourTargetPct: 0.26 },
  { id: 'pulse',   name: 'Pulse',        type: 'nightclub',  labourTargetPct: 0.22 },
];

// ── Roles + rates (Bartender £12.50 … Door £13.50 SIA) ──────────────────────
export const ROLES = {
  bartender:  { lbl: 'Bartender',      grp: 'bar',     rate: 12.50 },
  barback:    { lbl: 'Barback',        grp: 'bar',     rate: 10.00, band: '18–20' },
  supervisor: { lbl: 'Supervisor',     grp: 'mgmt',    rate: 14.50 },
  server:     { lbl: 'Server',         grp: 'floor',   rate: 12.21 },
  host:       { lbl: 'Host',           grp: 'floor',   rate: 12.21 },
  chef:       { lbl: 'Chef',           grp: 'kitchen', rate: 15.50 },
  kp:         { lbl: 'Kitchen Porter', grp: 'kitchen', rate: 11.50 },
  dutymgr:    { lbl: 'Duty Manager',   grp: 'mgmt',    rate: null, salary: 32000 },
  door:       { lbl: 'Door',           grp: 'door',    rate: 13.50, requiresSIA: true },
};

// ── Section coverage minimums + forecast/target (The Anchor) ────────────────
export const SECTION_REQ = { bar: 2, floor: 2, kitchen: 1, door: 1 };
export const FORECAST = [3200, 2800, 3000, 3600, 5200, 7400, 6100]; // forecast sales per day
export const LABOUR_TARGET = 0.28;

// ── Roster (The Anchor) — staff grouped by section.
//    days = { dayIdx: [start, end, section] | { off: 'Holiday' } } ───────────
export const GROUPS = [
  { name: 'Management', staff: [
    { nm: 'Dani Fox',     role: 'dutymgr',    days: { 0: ['10:00', '18:00', 'mgmt'], 1: ['10:00', '18:00', 'mgmt'], 3: ['14:00', '23:00', 'mgmt'], 4: ['16:00', '01:00', 'mgmt'], 5: ['16:00', '02:00', 'mgmt'] } },
    { nm: 'Chris Bell',   role: 'supervisor', days: { 1: ['16:00', '00:00', 'mgmt'], 2: ['16:00', '00:00', 'mgmt'], 4: ['17:00', '01:00', 'mgmt'], 5: ['17:00', '02:00', 'mgmt'], 6: ['12:00', '20:00', 'mgmt'] } },
  ] },
  { name: 'Bar', staff: [
    { nm: 'Mia Carroll',  role: 'bartender',  days: { 0: ['17:00', '23:00', 'bar'], 3: ['17:00', '00:00', 'bar'], 4: ['18:00', '02:00', 'bar'], 5: ['18:00', '02:00', 'bar'] } },
    { nm: 'Jay Okonkwo',  role: 'bartender',  days: { 1: ['17:00', '23:00', 'bar'], 2: ['17:00', '23:00', 'bar'], 4: ['18:00', '02:00', 'bar'], 5: ['18:00', '02:00', 'bar'], 6: ['14:00', '22:00', 'bar'] }, blocked: 'rtw' },
    { nm: 'Ruby Hayes',   role: 'barback',    days: { 4: ['19:00', '02:00', 'bar'], 5: ['19:00', '02:00', 'bar'] }, band: '18–20' },
  ] },
  { name: 'Floor', staff: [
    { nm: 'Tom Searle',   role: 'server',     days: { 0: ['11:00', '17:00', 'floor'], 1: ['11:00', '17:00', 'floor'], 4: ['17:00', '23:00', 'floor'], 5: ['12:00', '20:00', 'floor'] } },
    { nm: 'Elena Russo',  role: 'server',     days: { 2: ['11:00', '17:00', 'floor'], 3: { off: 'Holiday' }, 4: { off: 'Holiday' }, 5: ['17:00', '23:00', 'floor'], 6: ['12:00', '20:00', 'floor'] } },
    { nm: 'Priya Shah',   role: 'host',       days: { 4: ['18:00', '00:00', 'floor'], 5: ['18:00', '00:00', 'floor'], 6: ['12:00', '18:00', 'floor'] } },
  ] },
  { name: 'Kitchen', staff: [
    { nm: 'Marco Bianchi', role: 'chef',      days: { 0: ['10:00', '18:00', 'kitchen'], 1: ['10:00', '18:00', 'kitchen'], 3: ['12:00', '22:00', 'kitchen'], 4: ['12:00', '22:00', 'kitchen'], 5: ['12:00', '22:00', 'kitchen'] } },
    { nm: 'Sam Doyle',    role: 'kp',         days: { 4: ['17:00', '23:00', 'kitchen'], 5: ['17:00', '23:00', 'kitchen'], 6: ['12:00', '20:00', 'kitchen'] }, band: 'under 18' },
  ] },
];

// Flat staff list (Team → Staff) derived from the roster.
export const STAFF = GROUPS.flatMap(g => g.staff.map(s => ({ ...s, section: g.name })));

// ── Timesheets (clock vs scheduled) ─────────────────────────────────────────
export const TIMESHEETS = [
  { nm: 'Mia Carroll',   role: 'bartender', sched: '17:00–23:00', inn: '16:57', out: '23:18', sch: 6,  act: 6.35, status: 'pending' },
  { nm: 'Jay Okonkwo',   role: 'bartender', sched: '17:00–23:00', inn: '17:02', out: '23:04', sch: 6,  act: 6.03, status: 'pending' },
  { nm: 'Marco Bianchi', role: 'chef',      sched: '12:00–22:00', inn: '11:51', out: '22:40', sch: 10, act: 10.8, status: 'pending' },
  { nm: 'Tom Searle',    role: 'server',    sched: '11:00–17:00', inn: '11:00', out: '16:58', sch: 6,  act: 5.97, status: 'approved' },
  { nm: 'Dani Fox',      role: 'dutymgr',   sched: '10:00–18:00', inn: '09:48', out: '18:32', sch: 8,  act: 8.7,  status: 'pending' },
  { nm: 'Ruby Hayes',    role: 'barback',   sched: '19:00–02:00', inn: '—',     out: '—',     sch: 7,  act: 0,    status: 'missing' },
];

// ── Tronc pool (card tips + service charge from POS) ────────────────────────
export const TRONC_POOL = 2840.00;
export const TRONC_HOURS = [
  { nm: 'Mia Carroll',   role: 'bartender', pts: 1.0, hrs: 24 },
  { nm: 'Jay Okonkwo',   role: 'bartender', pts: 1.0, hrs: 28 },
  { nm: 'Ruby Hayes',    role: 'barback',   pts: 0.6, hrs: 14 },
  { nm: 'Tom Searle',    role: 'server',    pts: 1.0, hrs: 22 },
  { nm: 'Elena Russo',   role: 'server',    pts: 1.0, hrs: 18 },
  { nm: 'Priya Shah',    role: 'host',      pts: 0.8, hrs: 18 },
  { nm: 'Marco Bianchi', role: 'chef',      pts: 1.2, hrs: 36 },
  { nm: 'Sam Doyle',     role: 'kp',        pts: 0.6, hrs: 19 },
];

// ── Pay & rates (rate card) ─────────────────────────────────────────────────
export const PAYROWS = [
  { role: 'Bartender',           grp: 'bar',     type: 'Hourly · role rate',   rate: '£12.50',     note: '21+ rate' },
  { role: 'Barback (18–20)',     grp: 'bar',     type: 'Hourly · age-banded',  rate: '£10.00',     note: 'NMW 18–20 band' },
  { role: 'Server',              grp: 'floor',   type: 'Hourly · NMW 21+',     rate: '£12.21',     note: 'National Minimum Wage' },
  { role: 'Host',                grp: 'floor',   type: 'Hourly · NMW 21+',     rate: '£12.21',     note: '' },
  { role: 'Chef',                grp: 'kitchen', type: 'Hourly · role rate',   rate: '£15.50',     note: '' },
  { role: 'Kitchen Porter (U18)',grp: 'kitchen', type: 'Hourly · age-banded',  rate: '£7.55',      note: 'NMW under-18 band' },
  { role: 'Supervisor',          grp: 'mgmt',    type: 'Hourly · role rate',   rate: '£14.50',     note: '' },
  { role: 'Duty Manager',        grp: 'mgmt',    type: 'Salaried',             rate: '£32,000/yr', note: '~£15.38/h equiv' },
  { role: 'Door / Security',     grp: 'door',    type: 'Hourly · premium',     rate: '£13.50',     note: 'SIA licensed' },
];

// ── Compliance & document vault ─────────────────────────────────────────────
export const COMPLIANCE = [
  { nm: 'Mia Carroll',   role: 'bartender', items: [['Right to work', 'valid', 'Verified 12 Mar 2025'], ['Food hygiene L2', 'valid', 'Exp 14 Aug 2027'], ['Personal licence', 'valid', '—']] },
  { nm: 'Ruby Hayes',    role: 'barback',   items: [['Right to work', 'valid', 'Verified 02 Jun 2026'], ['Under-18 hours', 'watch', 'Max 8h/day · no after 22:00']] },
  { nm: 'Marco Bianchi', role: 'chef',      items: [['Right to work', 'valid', '—'], ['Food hygiene L3', 'expiring', 'Exp 28 Jun 2026 · 20 days'], ['Allergen training', 'valid', 'Exp 2027']] },
  { nm: 'Jay Okonkwo',   role: 'bartender', items: [['Right to work', 'expired', 'Visa exp 01 Jun 2026 · action needed'], ['Personal licence', 'valid', '—']] },
  { nm: 'Dani Fox',      role: 'dutymgr',   items: [['Right to work', 'valid', '—'], ['Personal licence', 'valid', 'DPS named premises'], ['First aid', 'expiring', 'Exp 10 Jul 2026']] },
  { nm: 'Sam Doyle',     role: 'kp',        items: [['Right to work', 'valid', 'Verified 18 May 2026'], ['Under-18 hours', 'watch', 'Term-time limits apply'], ['Food hygiene L2', 'missing', 'Not yet uploaded']] },
];
