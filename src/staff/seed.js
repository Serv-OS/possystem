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
