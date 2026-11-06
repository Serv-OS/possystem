// src/backoffice/sections/marketing/Segments.jsx
//
// Marketing → Segments (slice 3): build audiences from RFM + demographics. Prebuilt audiences
// (VIPs, lapsed, birthdays this week, …) plus a dynamic rule builder. Membership is computed live by
// the marketing-segments edge fn (marketing_resolve_segment over the customer_rfm view). Segments feed
// the campaign engine (slice 4). The send itself re-checks consent + suppression, so targeting here is
// about WHO to reach; deliverability is enforced at send time.
//
// 5.12.67 (Peter: "Segment by item ordered. And/or logic. Loyalty points stamps"): a rule can be a
// GROUP (match all / any of its own rules) to three levels, so "VIPs who ordered pizza OR lapsed
// customers with email" is one segment. New rule fields: ordered an item / anything in a category in
// the last N days (every channel, every venue; pickers fed by the organisation's menu), and the
// loyalty fields (points balance, points to next reward, stamps on card, stamps to go, rewards
// ready, member or not, tier). Old flat segments open and save unchanged (one level group).

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import { EmojiIcon } from '../../../components/ServOSIcons';
import { currencySymbol } from '../../../lib/currency';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 820 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--bdr2)' },
  ruleRow: { display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.2fr auto', gap: 8, alignItems: 'center', marginBottom: 8 },
  prebuilt: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 },
  pcard: { border: '1px solid var(--bdr2)', borderRadius: 12, padding: 12, background: 'var(--bg2)' },
};

const FIELDS = [
  // 5.12.57: read when shown, so it names the venue's own money ($ at a US venue).
  { v: 'lifetime_revenue', get l() { return `Total spend (${currencySymbol()})`; }, t: 'num', g: 'Visits and spend' },
  { v: 'visit_count', l: 'Number of visits', t: 'num', g: 'Visits and spend' },
  { v: 'days_since_visit', l: 'Days since last visit', t: 'num', g: 'Visits and spend' },
  { v: 'signed_up_days', l: 'Days since signup', t: 'num', g: 'Visits and spend' },
  { v: 'never_visited', l: 'Never visited', t: 'bool', g: 'Visits and spend' },
  // 5.12.68 (multi site): which venues they visit; decided per venue from customer_locations.
  { v: 'venue', l: 'Visited a venue', t: 'venue', g: 'Where they visit' },
  { v: 'home_venue', l: 'Home venue (visits most)', t: 'home', g: 'Where they visit' },
  { v: 'ordered_item', l: 'Ordered an item', t: 'item', g: 'What they ordered' },
  { v: 'ordered_category', l: 'Ordered from a category', t: 'cat', g: 'What they ordered' },
  { v: 'points_balance', l: 'Points balance', t: 'num', g: 'Loyalty' },
  { v: 'points_to_next_reward', l: 'Points to next reward', t: 'num', g: 'Loyalty' },
  { v: 'stamps_earned', l: 'Stamps on card', t: 'num', g: 'Loyalty' },
  { v: 'stamps_to_go', l: 'Stamps to go', t: 'num', g: 'Loyalty' },
  { v: 'rewards_ready', l: 'Rewards ready', t: 'num', g: 'Loyalty' },
  { v: 'loyalty_member', l: 'Loyalty member', t: 'bool', g: 'Loyalty' },
  { v: 'tier', l: 'Loyalty tier', t: 'tier', g: 'Loyalty' },
  { v: 'birthday_in_days', l: 'Days until birthday', t: 'num', g: 'About them' },
  { v: 'has_birthday', l: 'Birthday on file', t: 'bool', g: 'About them' },
  { v: 'source', l: 'Signup source', t: 'text', g: 'About them' },
  { v: 'marketing_opt_in', l: 'Opted in to marketing', t: 'bool', g: 'About them' },
  { v: 'has_email', l: 'Has email', t: 'bool', g: 'About them' },
  { v: 'has_phone', l: 'Has mobile', t: 'bool', g: 'About them' },
  { v: 'is_local', l: 'Local customer', t: 'bool', g: 'About them' },
];
const GROUPS = ['Visits and spend', 'Where they visit', 'What they ordered', 'Loyalty', 'About them'];
const OPS = {
  num: [['gte', '≥'], ['lte', '≤'], ['gt', '>'], ['lt', '<'], ['eq', '='], ['neq', '≠']],
  text: [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['in', 'is any of']],
  bool: [['is_true', 'yes'], ['is_false', 'no']],
  item: [['in', 'ordered'], ['not_in', 'did not order']],
  cat: [['in', 'ordered from'], ['not_in', 'did not order from']],
  venue: [['in', 'visited'], ['not_in', 'did not visit']],
  home: [['in', 'is'], ['not_in', 'is not']],
  tier: [['eq', 'is'], ['neq', 'is not']],
};
const ftype = (f) => (FIELDS.find((x) => x.v === f) || {}).t || 'num';
const isGroup = (r) => !!r && Array.isArray(r.rules);
export const MAX_DEPTH = 3;

// editor rule -> wire rule for the resolver (a group is carried as it is, its rules converted)
const toWire = (r) => {
  if (isGroup(r)) return { match: r.match === 'any' ? 'any' : 'all', rules: (r.rules || []).map(toWire) };
  const t = ftype(r.field);
  if (t === 'bool') return { field: r.field, op: r.op };
  if (t === 'item' || t === 'cat') {
    const picks = Array.isArray(r.picks) ? r.picks : [];
    const ids = [...new Set(picks.flatMap((p) => p.ids || []))];
    const key = t === 'item' ? 'items' : 'categories';
    // picks (label + ids) ride along in the value so the editor can show the names again; the resolver reads items/categories/days only
    return { field: r.field, op: r.op === 'not_in' ? 'not_in' : 'in', value: { [key]: ids, days: Math.max(1, Math.round(Number(r.days) || 90)), picks: picks.map((p) => ({ label: p.label, ids: p.ids || [] })) } };
  }
  if (t === 'venue' || t === 'home') {
    const picks = Array.isArray(r.picks) ? r.picks : [];
    const ids = [...new Set(picks.flatMap((p) => p.ids || []))];
    const days = t === 'venue' ? Math.round(Number(r.days) || 0) : 0;
    // venues (ids) and days are what the resolver reads; picks carry the names for the editor
    return { field: r.field, op: r.op === 'not_in' ? 'not_in' : 'in', value: { venues: ids, ...(days > 0 ? { days } : {}), picks: picks.map((p) => ({ label: p.label, ids: p.ids || [] })) } };
  }
  if (t === 'tier') return { field: 'tier', op: r.op, value: String(r.value ?? '') };
  if (r.op === 'in') return { field: r.field, op: 'in', value: String(r.value || '').split(',').map((s) => s.trim()).filter(Boolean) };
  if (t === 'num') return { field: r.field, op: r.op, value: Number(r.value) || 0 };
  return { field: r.field, op: r.op, value: String(r.value ?? '') };
};
// wire rule -> editor rule (item picks come back from the saved value's picks)
const toEdit = (r) => {
  if (isGroup(r)) return { match: r.match === 'any' ? 'any' : 'all', rules: (r.rules || []).map(toEdit) };
  const t = ftype(r.field);
  if (t === 'item' || t === 'cat') {
    const v = r.value && typeof r.value === 'object' ? r.value : {};
    const ids = Array.isArray(v.items) ? v.items : Array.isArray(v.categories) ? v.categories : [];
    const picks = Array.isArray(v.picks) && v.picks.length ? v.picks.filter((p) => p && p.label).map((p) => ({ label: String(p.label), ids: Array.isArray(p.ids) ? p.ids : [] }))
      : (ids.length ? [{ label: `${ids.length} saved`, ids }] : []);
    return { field: r.field, op: r.op === 'not_in' ? 'not_in' : 'in', picks, days: Number(v.days) || 90 };
  }
  if (t === 'venue' || t === 'home') {
    const v = r.value && typeof r.value === 'object' ? r.value : {};
    const ids = Array.isArray(v.venues) ? v.venues : [];
    const picks = Array.isArray(v.picks) && v.picks.length ? v.picks.filter((p) => p && p.label).map((p) => ({ label: String(p.label), ids: Array.isArray(p.ids) ? p.ids : [] }))
      : (ids.length ? [{ label: `${ids.length} saved`, ids }] : []);
    return { field: r.field, op: r.op === 'not_in' ? 'not_in' : 'in', picks, days: Number(v.days) || 0 };
  }
  return { field: r.field, op: r.op || (t === 'bool' ? 'is_true' : OPS[t][0][0]), value: Array.isArray(r.value) ? r.value.join(', ') : (r.value ?? '') };
};
const blankRule = (field = 'visit_count') => {
  const t = ftype(field);
  if (t === 'item' || t === 'cat') return { field, op: 'in', picks: [], days: 90 };
  if (t === 'venue' || t === 'home') return { field, op: 'in', picks: [], days: 0 };
  if (t === 'bool') return { field, op: 'is_true', value: '' };
  return { field, op: OPS[t][0][0], value: t === 'num' ? 1 : '' };
};

const BLANK = { name: '', description: '', match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 100 }] };

// A picker for items or categories: type to search the organisation's menu, pick several.
// 5.12.68: kind 'venue' or 'home' lists the company's venues (shown without typing, there are few).
function MenuPicker({ kind, picks, onChange, catalogue }) {
  const [q, setQ] = useState('');
  const isVenue = kind === 'venue' || kind === 'home';
  const list = kind === 'item' ? (catalogue?.items || []) : kind === 'cat' ? (catalogue?.categories || []) : (catalogue?.venues || []).map((v) => ({ label: v.name || v.id, ids: [v.id] }));
  const hits = q.trim() ? list.filter((e) => e.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12) : (isVenue ? list.slice(0, 50) : []);
  const chosen = new Set((picks || []).map((p) => p.label));
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {(picks || []).map((p) => (
          <span key={p.label} style={{ ...S.pill, display: 'inline-flex', gap: 5, alignItems: 'center' }}>{p.label}
            <button type="button" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--t3)', padding: 0, fontSize: 12 }} onClick={() => onChange(picks.filter((x) => x.label !== p.label))} title="Remove">✕</button>
          </span>
        ))}
      </div>
      <input style={S.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={catalogue ? (kind === 'item' ? 'Type an item name' : kind === 'cat' ? 'Type a category name' : 'Pick a venue below') : 'Loading…'} />
      {hits.length > 0 && (
        <div style={{ border: '1px solid var(--bdr2)', borderRadius: 8, marginTop: 4, background: 'var(--bg1)', maxHeight: 180, overflowY: 'auto' }}>
          {hits.map((e) => (
            <button type="button" key={e.label} disabled={chosen.has(e.label)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'transparent', cursor: chosen.has(e.label) ? 'default' : 'pointer', color: chosen.has(e.label) ? 'var(--t4)' : 'var(--t1)', fontSize: 12.5, fontFamily: 'inherit' }}
              onClick={() => { onChange([...(picks || []), { label: e.label, ids: e.ids }]); setQ(''); }}>
              {e.label}{e.venues > 1 ? <span style={{ color: 'var(--t4)' }}> · {e.venues} venues</span> : null}
            </button>
          ))}
        </div>
      )}
      {q.trim() && !hits.length && catalogue && <div style={S.hint}>Nothing {isVenue ? 'in your venues' : 'on the menu'} matches "{q.trim()}".</div>}
    </div>
  );
}

// One rule row.
function RuleRow({ r, onChange, onRemove, catalogue }) {
  const t = ftype(r.field);
  const changeField = (field) => onChange(blankRule(field));
  return (
    <div style={{ ...S.ruleRow, gridTemplateColumns: t === 'item' || t === 'cat' || t === 'venue' || t === 'home' ? '1.2fr 1fr 2fr auto' : '1.4fr 1fr 1.2fr auto', alignItems: 'start' }}>
      <select style={S.input} value={r.field} onChange={(e) => changeField(e.target.value)}>
        {GROUPS.map((g) => <optgroup key={g} label={g}>{FIELDS.filter((f) => f.g === g).map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</optgroup>)}
      </select>
      <select style={S.input} value={r.op} onChange={(e) => onChange({ ...r, op: e.target.value })}>
        {OPS[t].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {t === 'bool' && <span style={{ fontSize: 12, color: 'var(--t4)', paddingTop: 10 }}>—</span>}
      {(t === 'item' || t === 'cat') && (
        <div>
          <MenuPicker kind={t} picks={r.picks} onChange={(picks) => onChange({ ...r, picks })} catalogue={catalogue} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--t3)' }}>in the last
            <input style={{ ...S.input, width: 70, padding: '5px 8px' }} type="number" min={1} max={730} value={r.days} onChange={(e) => onChange({ ...r, days: e.target.value })} /> days, on any channel at any venue
          </div>
        </div>
      )}
      {(t === 'venue' || t === 'home') && (
        <div>
          <MenuPicker kind={t} picks={r.picks} onChange={(picks) => onChange({ ...r, picks })} catalogue={catalogue} />
          {t === 'venue' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--t3)' }}>in the last
              <input style={{ ...S.input, width: 70, padding: '5px 8px' }} type="number" min={0} max={730} value={r.days} onChange={(e) => onChange({ ...r, days: e.target.value })} /> days <span style={{ color: 'var(--t4)' }}>(0 = any time)</span>
            </div>
          )}
          {t === 'home' && <div style={{ ...S.hint, marginTop: 6 }}>The venue they visit most often.</div>}
        </div>
      )}
      {t === 'tier' && (
        <select style={S.input} value={r.value} onChange={(e) => onChange({ ...r, value: e.target.value })}>
          <option value="">Pick a tier</option>
          {(catalogue?.tiers || []).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
        </select>
      )}
      {(t === 'num' || t === 'text') && (
        <input style={S.input} value={r.value} onChange={(e) => onChange({ ...r, value: e.target.value })} placeholder={r.op === 'in' ? 'qr, wifi, online' : t === 'num' ? '0' : 'value'} type={t === 'num' && r.op !== 'in' ? 'number' : 'text'} />
      )}
      <button style={{ ...S.ghost, padding: '6px 9px' }} onClick={onRemove} title="Remove">✕</button>
    </div>
  );
}

// A group: match all / any of its rules, which may be rules or groups (to three levels).
function GroupEditor({ g, depth, onChange, onRemove, catalogue }) {
  const rules = g.rules || [];
  const setAt = (i, v) => onChange({ ...g, rules: rules.map((x, j) => (j === i ? v : x)) });
  const rmAt = (i) => onChange({ ...g, rules: rules.filter((_, j) => j !== i) });
  const add = () => onChange({ ...g, rules: [...rules, blankRule()] });
  const addGroup = () => onChange({ ...g, rules: [...rules, { match: g.match === 'any' ? 'all' : 'any', rules: [blankRule()] }] });
  const word = g.match === 'any' ? 'OR' : 'AND';
  return (
    <div style={{ border: depth > 1 ? '1px dashed var(--bdr2)' : 'none', borderRadius: 10, padding: depth > 1 ? '10px 12px' : 0, marginBottom: 8, background: depth > 1 ? (depth === 2 ? 'var(--bg2)' : 'var(--bg1)') : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
        <span style={{ fontSize: 12.5, color: 'var(--t2)', fontWeight: 700 }}>{depth > 1 ? 'Group: match' : 'Match'}</span>
        <select style={{ ...S.input, width: 'auto' }} value={g.match === 'any' ? 'any' : 'all'} onChange={(e) => onChange({ ...g, match: e.target.value })}>
          <option value="all">ALL of these</option>
          <option value="any">ANY of these</option>
        </select>
        {depth > 1 && <button style={{ ...S.ghost, padding: '5px 9px', marginLeft: 'auto' }} onClick={onRemove} title="Remove group">Remove group</button>}
      </div>
      {rules.map((r, i) => (
        <div key={i}>
          {i > 0 && <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--t4)', letterSpacing: '.06em', margin: '2px 0 8px 4px' }}>{word}</div>}
          {isGroup(r)
            ? <GroupEditor g={r} depth={depth + 1} onChange={(v) => setAt(i, v)} onRemove={() => rmAt(i)} catalogue={catalogue} />
            : <RuleRow r={r} onChange={(v) => setAt(i, v)} onRemove={() => rmAt(i)} catalogue={catalogue} />}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <button style={S.ghost} onClick={add}>+ Add condition</button>
        {depth < MAX_DEPTH && <button style={S.ghost} onClick={addGroup} title="A group of conditions matched the other way round (all inside any, any inside all)">+ Add group ({g.match === 'any' ? 'all' : 'any'} of)</button>}
      </div>
    </div>
  );
}

export default function Segments() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState([]);
  const [prebuilt, setPrebuilt] = useState([]);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);   // { count, sample } | { busy } | { err }
  const [save, setSave] = useState({});
  const [pcounts, setPcounts] = useState({});      // prebuilt key -> count
  const [catalogue, setCatalogue] = useState(null); // 5.12.67: { items, categories, tiers, programs } across the organisation

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-segments', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => { if (error) throw new Error(error.message); if (data?.error) throw new Error(data.error); return data; });

  const load = async (id = locId) => {
    const { data } = await supabase.functions.invoke('marketing-segments', { body: { action: 'list_segments', ops_location_id: id } });
    setSegments(data?.segments || []); setPrebuilt(data?.prebuilt || []);
  };

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        await load(id);
        // the pickers' menu and loyalty lists, after the page is up (never blocks the list)
        supabase.functions.invoke('marketing-segments', { body: { action: 'menu_catalogue', ops_location_id: id } })
          .then(({ data }) => setCatalogue(data && !data.error ? data : { items: [], categories: [], tiers: [], programs: [] }))
          .catch(() => setCatalogue({ items: [], categories: [], tiers: [], programs: [] }));
      } catch { /* the page shows its empty state */ } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const definitionOf = (e) => ({ match: e.match, rules: e.rules.map(toWire) });

  const doPreview = async (e = editing) => {
    setPreview({ busy: true });
    try { const d = await call('preview_segment', { definition: definitionOf(e) }); setPreview(d); }
    catch (err) { setPreview({ err: err.message }); }
  };

  const previewPrebuilt = async (p) => {
    setPcounts((s) => ({ ...s, [p.key]: '…' }));
    try { const d = await call('preview_segment', { definition: p.definition }); setPcounts((s) => ({ ...s, [p.key]: d.count })); }
    catch { setPcounts((s) => ({ ...s, [p.key]: '?' })); }
  };

  const editPrebuilt = (p) => { setPreview(null); setEditing({ name: p.name, description: p.description, match: p.definition.match || 'all', rules: (p.definition.rules || []).map(toEdit), prebuilt_key: p.key }); };

  const saveSeg = async () => {
    if (!editing?.name?.trim()) { setSave({ err: 'Give the segment a name.' }); return; }
    setSave({ busy: true });
    try {
      const segment = { ...(editing.id ? { id: editing.id } : {}), name: editing.name.trim(), description: editing.description || null, kind: 'dynamic', definition: definitionOf(editing), active: true };
      await call('save_segment', { segment });
      setEditing(null); setPreview(null); setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2000);
      await load();
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const del = async (seg) => { if (!window.confirm(`Delete segment "${seg.name}"?`)) return; try { await call('delete_segment', { id: seg.id }); await load(); } catch (e) { alert(e.message); } };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage segments.</div>;

  return (
    <div>
      <h1 style={S.h1}>Segments</h1>
      <div style={S.sub}>Build audiences from spend, visits, what people ordered, loyalty points and stamps, and birthdays. Group conditions with AND and OR. Consent and suppression are always re-checked when a message is actually sent.</div>

      {/* Prebuilt */}
      {!editing && (
        <div style={S.card}>
          <h2 style={S.h2}>Prebuilt audiences</h2>
          <div style={S.prebuilt}>
            {prebuilt.map((p) => (
              <div key={p.key} style={S.pcard}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--t1)', display: 'flex', alignItems: 'center', gap: 6 }}><EmojiIcon value={p.icon} fallback="users" size={15} />{p.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--t3)', margin: '4px 0 10px', minHeight: 30 }}>{p.description}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button style={{ ...S.ghost, padding: '5px 10px' }} onClick={() => previewPrebuilt(p)}>Count{pcounts[p.key] !== undefined ? `: ${pcounts[p.key]}` : ''}</button>
                  <button style={{ ...S.ghost, padding: '5px 10px' }} onClick={() => editPrebuilt(p)}>Customise</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Saved segments */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ ...S.h2, margin: 0 }}>Your segments</h2>
          {!editing && <button style={S.btn} onClick={() => { setEditing({ ...BLANK, rules: BLANK.rules.map((r) => ({ ...r })) }); setPreview(null); }}>+ New segment</button>}
        </div>
        {!editing && segments.length === 0 && <div style={{ ...S.hint, padding: '14px 0' }}>No saved segments yet. Customise a prebuilt audience or build one from scratch.</div>}
        {!editing && segments.map((seg) => (
          <div key={seg.id} style={S.row}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{seg.name} {seg.member_count != null && <span style={{ ...S.pill, marginLeft: 6 }}>{seg.member_count} customers</span>}</div>
              {seg.description && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{seg.description}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button style={S.ghost} onClick={() => { setEditing({ id: seg.id, name: seg.name, description: seg.description || '', match: seg.definition?.match || 'all', rules: (seg.definition?.rules || []).map(toEdit) }); setPreview(null); }}>Edit</button>
              <button style={{ ...S.ghost, color: 'var(--red)' }} onClick={() => del(seg)}>Delete</button>
            </div>
          </div>
        ))}

        {editing && (
          <div style={{ marginTop: 12 }}>
            <div style={S.field}><label style={S.label}>Segment name</label><input style={S.input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Lapsed VIPs" /></div>
            <div style={S.field}><label style={S.label}>Description <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label><input style={S.input} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>

            <GroupEditor g={{ match: editing.match, rules: editing.rules }} depth={1} onChange={(g) => setEditing((e) => ({ ...e, match: g.match, rules: g.rules }))} catalogue={catalogue} />
            <div style={S.hint}>A group is matched the other way round from its parent, so you can say "VIPs who ordered pizza, OR lapsed customers with an email". Up to three levels.</div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
              <button style={S.btn} onClick={saveSeg} disabled={save.busy}>{save.busy ? 'Saving…' : (editing.id ? 'Save segment' : 'Create segment')}</button>
              <button style={S.ghost} onClick={() => doPreview()} disabled={preview?.busy}>{preview?.busy ? 'Counting…' : 'Preview audience'}</button>
              <button style={S.ghost} onClick={() => { setEditing(null); setPreview(null); setSave({}); }}>Cancel</button>
              {save.err && <span style={S.err}>{save.err}</span>}
            </div>

            {preview && !preview.busy && !preview.err && (
              <div style={{ marginTop: 14, padding: 12, border: '1px solid var(--bdr2)', borderRadius: 10, background: 'var(--bg2)' }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{preview.count} customer{preview.count === 1 ? '' : 's'} match</div>
                {(preview.sample || []).length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--t3)', lineHeight: 1.7 }}>
                    {preview.sample.map((c) => <div key={c.id}>· {c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)'} {c.email ? `— ${c.email}` : c.phone ? `— ${c.phone}` : ''}</div>)}
                    {preview.count > preview.sample.length && <div style={{ color: 'var(--t4)' }}>…and {preview.count - preview.sample.length} more</div>}
                  </div>
                )}
              </div>
            )}
            {preview?.err && <div style={{ ...S.err, marginTop: 10 }}>{preview.err}</div>}
          </div>
        )}
        {save.done && !editing && <div style={{ ...S.ok, marginTop: 10 }}>✓ Saved</div>}
      </div>
    </div>
  );
}
