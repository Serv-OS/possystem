// src/components/TimezoneOptions.jsx: the <option>s for a venue time zone picker (5.12.48).
// Every zone a venue could be in, Common first, then by region (lib/timezones.js), so no picker can
// force the wrong zone on a site again. A saved zone missing from the list still shows, at the top.
import { TIMEZONE_GROUPS, TIMEZONES } from '../lib/timezones';

export default function TimezoneOptions({ value }) {
  const known = !value || TIMEZONES.some((z) => z.value === value);
  return (
    <>
      {!known && <option value={value}>{value}</option>}
      {TIMEZONE_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.zones.map((z) => <option key={`${g.label}:${z.value}`} value={z.value}>{z.label}</option>)}
        </optgroup>
      ))}
    </>
  );
}
