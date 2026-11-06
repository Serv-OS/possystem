// src/backoffice/sections/marketing/SitesScope.jsx (6 Nov 2026, 5.12.68)
//
// Peter: "support much more multi site functions". The "Which sites" picker a campaign and an
// automation carry: All sites (the default, an empty list) or a tick per venue. Hidden for a one
// venue company, where there is nothing to choose. The list is saved as venue ids
// (campaigns.schedule.location_ids, workflows.entry_trigger.location_ids) and the engine narrows
// the audience to customers who have visited one of them (supabase/functions/_shared/venueScope.js).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanIds = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || '').trim().toLowerCase()).filter((x) => UUID_RE.test(x)))];

const S = {
  field: { marginBottom: 12 },
  label: { display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  chip: (on) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 999, border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'color-mix(in srgb, var(--acc) 14%, transparent)' : 'var(--bg1)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }),
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 6 },
};

const HINTS = {
  campaign: (n) => (n === 0 ? 'This campaign goes to the whole company.' : `Only customers who have visited ${n === 1 ? 'this site' : 'one of these sites'} get this campaign.`),
  automation: (n) => (n === 0 ? 'This automation runs for the whole company.' : `Only customers who have visited ${n === 1 ? 'this site' : 'one of these sites'} join this automation.`),
  // 5.12.69: an offer's sites are where its codes can be USED (promo-redeem refuses elsewhere).
  offer: (n) => (n === 0 ? 'Codes from this offer work at every site.' : `Codes from this offer work only at ${n === 1 ? 'this site' : 'these sites'}.`),
};

export default function SitesScope({ venues, value, onChange, what = 'campaign' }) {
  const list = Array.isArray(venues) ? venues : [];
  if (list.length < 2) return null;
  const ids = cleanIds(value);
  const all = ids.length === 0;
  const has = (id) => all || ids.includes(String(id).toLowerCase());
  const toggle = (id) => {
    const key = String(id).toLowerCase();
    const next = all ? list.map((v) => String(v.id).toLowerCase()).filter((x) => x !== key) : (ids.includes(key) ? ids.filter((x) => x !== key) : [...ids, key]);
    onChange(next.length === 0 || next.length >= list.length ? [] : next);
  };
  return (
    <div style={S.field}>
      <label style={S.label}>Which sites</label>
      <div style={S.row}>
        <button type="button" style={S.chip(all)} onClick={() => onChange([])} aria-pressed={all}>{all ? '✓ ' : ''}All sites</button>
        {list.map((v) => <button type="button" key={v.id} style={S.chip(!all && has(v.id))} onClick={() => toggle(v.id)} aria-pressed={!all && has(v.id)}>{!all && has(v.id) ? '✓ ' : ''}{v.name || v.id}</button>)}
      </div>
      <div style={S.hint}>{(HINTS[what] || HINTS.campaign)(all ? 0 : ids.length)}</div>
    </div>
  );
}
