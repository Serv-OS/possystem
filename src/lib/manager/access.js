// src/lib/manager/access.js
//
// Role-adaptive access for the ServOS Manager app. Pure — unit-tested. Maps a signed-in staff
// role (+ any per-person permission overrides from staff_members.permissions) to the feature
// flags that gate the tabs. Defaults reproduce the §3 role presets; any individual permission key
// can widen a person's access without changing their role. The SERVER (requireAccess) is the real
// gate for management actions — these flags only decide which tabs/cards render.

// Role presets. reports_view: 'full' | 'view' | false.
// SINGLE-VENUE app: this runs ONE venue (the paired location). Multi-site rollups deliberately live
// in the (more complex) web Back Office — there is no venue switcher or cross-location aggregation here.
const PRESETS = {
  owner:      { reports_view: 'full', team_live: true,  team_approvals: true,  ops_checks: true, kitchen: true },
  manager:    { reports_view: 'full', team_live: true,  team_approvals: true,  ops_checks: true, kitchen: true },
  supervisor: { reports_view: 'view', team_live: true,  team_approvals: false, ops_checks: true, kitchen: true },
  staff:      { reports_view: false,  team_live: false, team_approvals: false, ops_checks: true, kitchen: true },
};

// Per-person permission keys (staff_members.permissions[]) that widen a flag, regardless of role.
const PERM_TO_FLAG = {
  manager_reports: 'reports_view', manager_team: 'team_live',
  manager_approvals: 'team_approvals', manager_ops: 'ops_checks', manager_kitchen: 'kitchen',
};

/** Resolve a role + permission overrides into boolean tab flags. Unknown role → 'staff' (safest). */
export function roleFlags(role, permissions = []) {
  const key = String(role || 'staff').toLowerCase().trim();
  const preset = PRESETS[key] || PRESETS.staff;
  const perms = Array.isArray(permissions) ? permissions : [];
  const has = (flag) => Object.entries(PERM_TO_FLAG).some(([p, f]) => f === flag && perms.includes(p));

  return {
    home: true,                                            // Home always shows; it adapts to the flags
    reports_view: !!preset.reports_view || has('reports_view'),
    reports_readonly: preset.reports_view === 'view' && !has('reports_view'),
    team_live: preset.team_live || has('team_live'),
    team_approvals: preset.team_approvals || has('team_approvals'),
    ops_checks: preset.ops_checks || has('ops_checks'),
    kitchen: preset.kitchen || has('kitchen'),
  };
}

// Tab definitions — each gated by a flag. Icons are ServOSIcons names.
export const TABS = [
  { key: 'home',    flag: 'home',         label: 'Home',    icon: 'home' },
  { key: 'reports', flag: 'reports_view', label: 'Reports', icon: 'reports' },
  { key: 'team',    flag: 'team_live',    label: 'Team',    icon: 'team' },
  { key: 'ops',     flag: 'ops_checks',   label: 'Ops',     icon: 'clipboard' },
  { key: 'kitchen', flag: 'kitchen',      label: 'Kitchen', icon: 'fire' },
];
