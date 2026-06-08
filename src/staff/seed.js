// src/staff/seed.js
//
// Workforce — config defaults + empty operational data.
// The fake roster/timesheets/tronc/compliance demo data has been removed so the
// system can be built + tested for real. Staff are added in Workforce → Staff
// (persisted), and can be promoted to a POS system user (Team page). Roles,
// sections and venues below are editable defaults (Workforce → Settings).

// Week shown in the rota (Mon→Sun). TODAY = index of "today".
export const DAYS = [['Mon', '8'], ['Tue', '9'], ['Wed', '10'], ['Thu', '11'], ['Fri', '12'], ['Sat', '13'], ['Sun', '14']];
export const TODAY = 0;

export const SECTIONS = { bar: 'Bar', floor: 'Floor', kitchen: 'Kitchen', door: 'Door' };

// ── Venues (editable in Workforce → Settings) ───────────────────────────────
export const VENUES = [
  { id: 'anchor', name: 'The Anchor', type: 'pub', labourTargetPct: 0.28 },
];

// ── Roles + rates (editable rate card; drives rota cost + tronc weight) ──────
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

// ── Section coverage minimums + labour target (config) ──────────────────────
export const SECTION_REQ = { bar: 2, floor: 2, kitchen: 1, door: 1 };
export const LABOUR_TARGET = 0.28;
// Forecast sales per day (POS-sourced when wired; 0 = not set yet).
export const FORECAST = [0, 0, 0, 0, 0, 0, 0];

// ── Operational data — empty (built by the operator) ────────────────────────
export const GROUPS = [];      // rota roster (built from real staff)
export const STAFF = [];       // HR records (added in Workforce → Staff)
export const TIMESHEETS = [];  // clock vs scheduled (from clock-ins)
export const TRONC_POOL = 0;   // card tips + service charge (POS)
export const TRONC_HOURS = []; // tronc participants
export const COMPLIANCE = [];  // document vault

// Pay & rates card — derived from the editable ROLES config.
export const PAYROWS = Object.values(ROLES).map(r => ({
  role: r.lbl, grp: r.grp,
  type: r.salary ? 'Salaried' : r.band ? 'Hourly · age-banded' : 'Hourly · role rate',
  rate: r.rate != null ? `£${r.rate.toFixed(2)}` : `£${(r.salary / 1000)}k/yr`,
  note: r.band ? `NMW ${r.band} band` : r.salary ? '~£15.38/h equiv' : r.requiresSIA ? 'SIA licensed' : '',
}));
