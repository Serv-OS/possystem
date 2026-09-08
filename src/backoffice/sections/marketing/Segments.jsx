// src/backoffice/sections/marketing/Segments.jsx
//
// Marketing → Segments (slice 3): build audiences from RFM + demographics. Prebuilt audiences
// (VIPs, lapsed, birthdays this week, …) plus a dynamic rule builder. Membership is computed live by
// the marketing-segments edge fn (marketing_resolve_segment over the customer_rfm view). Segments feed
// the campaign engine (slice 4). The send itself re-checks consent + suppression, so targeting here is
// about WHO to reach; deliverability is enforced at send time.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

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
  { v: 'lifetime_revenue', l: 'Total spend (£)', t: 'num' },
  { v: 'visit_count', l: 'Number of visits', t: 'num' },
  { v: 'days_since_visit', l: 'Days since last visit', t: 'num' },
  { v: 'signed_up_days', l: 'Days since signup', t: 'num' },
  { v: 'birthday_in_days', l: 'Days until birthday', t: 'num' },
  { v: 'source', l: 'Signup source', t: 'text' },
  { v: 'marketing_opt_in', l: 'Opted in to marketing', t: 'bool' },
  { v: 'has_email', l: 'Has email', t: 'bool' },
  { v: 'has_phone', l: 'Has mobile', t: 'bool' },
  { v: 'is_local', l: 'Local customer', t: 'bool' },
  { v: 'never_visited', l: 'Never visited', t: 'bool' },
  { v: 'has_birthday', l: 'Birthday on file', t: 'bool' },
];
const OPS = {
  num: [['gte', '≥'], ['lte', '≤'], ['gt', '>'], ['lt', '<'], ['eq', '='], ['neq', '≠']],
  text: [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['in', 'is any of']],
  bool: [['is_true', 'yes'], ['is_false', 'no']],
};
const ftype = (f) => (FIELDS.find((x) => x.v === f) || {}).t || 'num';

// editor rule -> wire rule for the resolver
const toWire = (r) => {
  const t = ftype(r.field);
  if (t === 'bool') return { field: r.field, op: r.op };
  if (r.op === 'in') return { field: r.field, op: 'in', value: String(r.value || '').split(',').map((s) => s.trim()).filter(Boolean) };
  if (t === 'num') return { field: r.field, op: r.op, value: Number(r.value) || 0 };
  return { field: r.field, op: r.op, value: String(r.value ?? '') };
};
// wire rule -> editor rule
const toEdit = (r) => ({ field: r.field, op: r.op || (ftype(r.field) === 'bool' ? 'is_true' : OPS[ftype(r.field)][0][0]), value: Array.isArray(r.value) ? r.value.join(', ') : (r.value ?? '') });

const BLANK = { name: '', description: '', match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 100 }] };

export default function Segments() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState([]);
  const [prebuilt, setPrebuilt] = useState([]);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);   // { count, sample } | { busy } | { err }
  const [save, setSave] = useState({});
  const [pcounts, setPcounts] = useState({});      // prebuilt key -> count

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
      } catch {} finally { setLoading(false); }
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

  // rule editing
  const setRule = (i, patch) => setEditing((e) => ({ ...e, rules: e.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const changeField = (i, field) => { const t = ftype(field); setRule(i, { field, op: t === 'bool' ? 'is_true' : OPS[t][0][0], value: t === 'bool' ? '' : '' }); };
  const addRule = () => setEditing((e) => ({ ...e, rules: [...e.rules, { field: 'visit_count', op: 'gte', value: 1 }] }));
  const rmRule = (i) => setEditing((e) => ({ ...e, rules: e.rules.filter((_, j) => j !== i) }));

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage segments.</div>;

  return (
    <div>
      <h1 style={S.h1}>Segments</h1>
      <div style={S.sub}>Build audiences from spend, visits, recency and birthdays. Use them to target campaigns. Consent and suppression are always re-checked when a message is actually sent.</div>

      {/* Prebuilt */}
      {!editing && (
        <div style={S.card}>
          <h2 style={S.h2}>Prebuilt audiences</h2>
          <div style={S.prebuilt}>
            {prebuilt.map((p) => (
              <div key={p.key} style={S.pcard}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--t1)' }}>{p.icon} {p.name}</div>
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 10px' }}>
              <span style={{ fontSize: 12.5, color: 'var(--t2)', fontWeight: 700 }}>Match</span>
              <select style={{ ...S.input, width: 'auto' }} value={editing.match} onChange={(e) => setEditing({ ...editing, match: e.target.value })}>
                <option value="all">ALL of these</option>
                <option value="any">ANY of these</option>
              </select>
            </div>

            {editing.rules.map((r, i) => {
              const t = ftype(r.field);
              return (
                <div key={i} style={S.ruleRow}>
                  <select style={S.input} value={r.field} onChange={(e) => changeField(i, e.target.value)}>
                    {FIELDS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
                  </select>
                  <select style={S.input} value={r.op} onChange={(e) => setRule(i, { op: e.target.value })}>
                    {OPS[t].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  {t === 'bool'
                    ? <span style={{ fontSize: 12, color: 'var(--t4)' }}>—</span>
                    : <input style={S.input} value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={r.op === 'in' ? 'qr, wifi, online' : t === 'num' ? '0' : 'value'} type={t === 'num' && r.op !== 'in' ? 'number' : 'text'} />}
                  <button style={{ ...S.ghost, padding: '6px 9px' }} onClick={() => rmRule(i)} title="Remove">✕</button>
                </div>
              );
            })}
            <button style={{ ...S.ghost, marginTop: 2 }} onClick={addRule}>+ Add condition</button>

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
