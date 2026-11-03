// src/lib/timezones.js: the one time zone list every venue picker uses (5.12.48).
//
// Peter, 3 Nov 2026: Mozz's four Utah sites were added with New York time because the Add location
// form only offered London, Paris, New York and Dubai (the Back Office company page added Los Angeles,
// the sites page ten zones, none of them Mountain). Location settings already had the full list
// below; it now lives here and Add location (admin portal and Back Office), the sites page and
// Location settings all read it. Moved from LocationSettings.jsx unchanged.
//
// Why the full list (v5.7.29): the venue timezone drives every business time decision (menu
// windows, reports, payroll weeks), so the picker must offer every zone a venue could be in. The US
// alone needs Eastern, Central, Mountain, Arizona (no DST), Pacific, Alaska and Hawaii. The full IANA
// list comes from the browser (Intl.supportedValuesOf) grouped by region with a live UTC offset on
// every entry; a curated Common group sits on top. Falls back to the curated list on browsers
// without supportedValuesOf.

export const COMMON_TIMEZONES = [
  ['Europe/London', 'United Kingdom'], ['Europe/Dublin', 'Ireland'],
  ['America/New_York', 'US Eastern'], ['America/Chicago', 'US Central'],
  ['America/Denver', 'US Mountain'], ['America/Phoenix', 'US Arizona (no DST)'],
  ['America/Los_Angeles', 'US Pacific'], ['America/Anchorage', 'US Alaska'],
  ['Pacific/Honolulu', 'US Hawaii'], ['America/Puerto_Rico', 'Puerto Rico'],
  ['America/Toronto', 'Canada Eastern'], ['America/Winnipeg', 'Canada Central'],
  ['America/Edmonton', 'Canada Mountain'], ['America/Vancouver', 'Canada Pacific'],
  ['America/Halifax', 'Canada Atlantic'], ['America/St_Johns', 'Newfoundland'],
  ['Europe/Paris', 'France'], ['Europe/Berlin', 'Germany'], ['Europe/Amsterdam', 'Netherlands'],
  ['Europe/Madrid', 'Spain'], ['Europe/Rome', 'Italy'], ['Europe/Lisbon', 'Portugal'],
  ['Asia/Dubai', 'UAE'], ['Asia/Singapore', 'Singapore'], ['Asia/Hong_Kong', 'Hong Kong'],
  ['Asia/Tokyo', 'Japan'], ['Australia/Sydney', 'Australia Eastern'],
  ['Australia/Brisbane', 'Australia Queensland (no DST)'], ['Australia/Adelaide', 'Australia Central'],
  ['Australia/Perth', 'Australia Western'], ['Pacific/Auckland', 'New Zealand'],
];

// "UTC+01:00" style offset for a zone right now (DST aware).
export function tzOffsetLabel(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date());
    const p = parts.find(x => x.type === 'timeZoneName')?.value || '';
    return p === 'GMT' ? 'UTC+00:00' : p.replace('GMT', 'UTC');
  } catch { return ''; }
}

export function buildTimezoneGroups() {
  const common = COMMON_TIMEZONES.map(([value, name]) => ({
    value, label: `${name} (${value.replace(/_/g, ' ')}, ${tzOffsetLabel(value)})`,
  }));
  let all = [];
  try { all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { all = []; }
  const byRegion = {};
  for (const tz of all) {
    const region = tz.includes('/') ? tz.split('/')[0] : 'Other';
    if (region === 'Etc' || region === 'SystemV' || region === 'US' || region === 'Canada') continue;
    (byRegion[region] ||= []).push({ value: tz, label: `${tz.replace(/_/g, ' ')} (${tzOffsetLabel(tz)})` });
  }
  const groups = [{ label: 'Common', zones: common }];
  for (const region of Object.keys(byRegion).sort()) groups.push({ label: region, zones: byRegion[region] });
  return groups;
}
export const TIMEZONE_GROUPS = buildTimezoneGroups();
export const TIMEZONES = TIMEZONE_GROUPS.flatMap(g => g.zones); // kept for any legacy reader
