import { useState, useEffect, useMemo } from 'react';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { UK_DEFAULT_RATES, US_DEFAULT_RATES } from '../../lib/tax';
import { reportSave } from '../../lib/saveHealth';
import { useStore } from '../../store';
import { assembleTaxProfiles } from '../../lib/rowMapping';
// v5.7.33: the REAL engine powers the builder's live preview. This is UI-only
// maths on a sample item; no till or customer page computes with the engine yet.
import { computeTax, validateProfile } from '../../lib/taxEngine';

const ORDER_TYPES = ['dine-in', 'takeaway', 'delivery', 'bar', 'counter'];
// Profile lines know about every channel, including collection (scope of the
// profiles engine, wider than the legacy applies_to list above).
const PROFILE_ORDER_TYPES = ['dine-in', 'takeaway', 'delivery', 'collection', 'bar', 'counter'];

const EMPTY = { name:'', code:'', rate:'', type:'inclusive', applies_to:['all'], is_default:false, active:true };

const S = {
  page:   { padding:'32px 40px', maxWidth:980 },
  h1:     { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub:    { fontSize:13, color:'var(--t3)', marginBottom:28 },
  card:   { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:22, marginBottom:12 },
  label:  { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input:  { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  select: { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  btn:    { padding:'9px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  row:    { display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 },
  badge:  { padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700 },
  helper: { fontSize:11, color:'var(--t4)', marginTop:4, lineHeight:1.5 },
};

const genId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// ═════════════════════════════════════════════════════════════════════════════
// TAX PROFILES (v5.7.33) — the builder. Profiles are live for SETUP only:
// nothing computes tax with them yet, so every write here changes zero charging
// behaviour. The live preview imports the real engine (lib/taxEngine.js) purely
// to show what a profile WILL do.
// ═════════════════════════════════════════════════════════════════════════════

// ── Line editor ──────────────────────────────────────────────────────────────
function LineEditor({ line, index, count, onChange, onRemove, onMove }) {
  const set = (k, v) => onChange({ ...line, [k]: v });
  const pctValue = line.rate === '' ? '' : String(+(Number(line.rate) * 100).toFixed(4));

  const toggleOrderType = (ot) => {
    const cur = Array.isArray(line.orderTypes) && line.orderTypes.length ? line.orderTypes : ['all'];
    if (cur.includes('all')) {
      set('orderTypes', [ot]);
    } else if (cur.includes(ot)) {
      const next = cur.filter(x => x !== ot);
      set('orderTypes', next.length ? next : ['all']);
    } else {
      set('orderTypes', [...cur, ot]);
    }
  };
  const otAll = !Array.isArray(line.orderTypes) || !line.orderTypes.length || line.orderTypes.includes('all');

  const chk = (k, label, helper) => (
    <div style={{ flex:1, minWidth:180 }}>
      <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--t2)' }}>
        <input type="checkbox" checked={line[k] === true} onChange={e => set(k, e.target.checked)}/>
        {label}
      </label>
      <div style={{ ...S.helper, marginLeft:22 }}>{helper}</div>
    </div>
  );

  return (
    <div style={{ border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:10, background:'var(--bg)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <span style={{ fontSize:11, fontWeight:800, color:'var(--t3)' }}>Line {index + 1}</span>
        {line.active === false && <span style={{ ...S.badge, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>Off</span>}
        <div style={{ flex:1 }}/>
        <button onClick={() => onMove(-1)} disabled={index === 0} title="Move up"
          style={{ ...S.btn, padding:'3px 9px', fontSize:12, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', opacity:index === 0 ? .4 : 1 }}>↑</button>
        <button onClick={() => onMove(1)} disabled={index === count - 1} title="Move down"
          style={{ ...S.btn, padding:'3px 9px', fontSize:12, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', opacity:index === count - 1 ? .4 : 1 }}>↓</button>
        <button onClick={onRemove} style={{ ...S.btn, padding:'3px 10px', fontSize:12, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)' }}>Remove</button>
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Name *</label>
          <input style={S.input} value={line.name} onChange={e => set('name', e.target.value)} placeholder="e.g. VAT, State sales tax"/>
        </div>
        <div>
          <label style={S.label}>Jurisdiction</label>
          <input style={S.input} value={line.jurisdiction || ''} onChange={e => set('jurisdiction', e.target.value)} placeholder="e.g. HMRC, City of Chicago"/>
        </div>
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Line type</label>
          <select style={S.select} value={line.lineType || 'rate'} onChange={e => set('lineType', e.target.value)}>
            <option value="rate">Percentage rate</option>
            {/* v5.7.34: unhidden — every receipt/renderer now prints per-unit
                lines (name + amount, no percent) and the rate-null guard sweep
                is in place, so per-unit creation is safe to offer. */}
            <option value="per_unit">Per-unit flat amount</option>
          </select>
        </div>
        {line.lineType === 'per_unit' ? (
          <div>
            <label style={S.label}>Amount per unit</label>
            <input style={S.input} type="number" min="0" step="0.01"
              value={line.flatAmount === '' ? '' : line.flatAmount}
              onChange={e => set('flatAmount', e.target.value === '' ? '' : parseFloat(e.target.value))}
              placeholder="e.g. 0.24"/>
            <div style={S.helper}>A fixed amount added per unit sold, always on top of the price.</div>
          </div>
        ) : (
          <div>
            <label style={S.label}>Rate %</label>
            <input style={S.input} type="number" min="0" max="100" step="0.001"
              value={pctValue}
              onChange={e => set('rate', e.target.value === '' ? '' : parseFloat(e.target.value) / 100)}
              placeholder="e.g. 20"/>
            <div style={S.helper}>Enter 20 for 20%. Stored as the decimal fraction 0.2.</div>
          </div>
        )}
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Inclusive or exclusive</label>
          <select style={S.select} value={line.mode === 'inclusive' ? 'inclusive' : 'exclusive'} onChange={e => set('mode', e.target.value)}>
            <option value="inclusive">Inclusive: already inside the price (UK VAT)</option>
            <option value="exclusive">Exclusive: added on top at checkout (US sales tax)</option>
          </select>
        </div>
        <div>
          <label style={S.label}>Tax basis</label>
          <select style={S.select} value={line.taxBasis || 'pre_discount'} onChange={e => set('taxBasis', e.target.value)}>
            <option value="pre_discount">Full price, before discounts</option>
            <option value="post_discount">Discounted price the customer actually pays</option>
          </select>
        </div>
      </div>

      <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginBottom:14 }}>
        {chk('compound', 'Compound', 'Also taxes the tax added by earlier lines, not just the item price.')}
        {chk('taxable', 'Taxable', 'Lets later compounding lines charge their tax on this line\'s amount too.')}
      </div>

      <div style={{ marginBottom:10 }}>
        <label style={S.label}>Applies to order types</label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          <button onClick={() => set('orderTypes', ['all'])} style={{
            ...S.btn, padding:'5px 12px',
            background: otAll ? 'var(--acc)' : 'var(--bg3)',
            color: otAll ? '#fff' : 'var(--t2)',
            border: `1.5px solid ${otAll ? 'var(--acc)' : 'var(--bdr)'}`,
          }}>All types</button>
          {PROFILE_ORDER_TYPES.map(ot => {
            const on = !otAll && line.orderTypes.includes(ot);
            return (
              <button key={ot} onClick={() => toggleOrderType(ot)} style={{
                ...S.btn, padding:'5px 12px',
                background: on ? 'var(--acc-d)' : 'var(--bg3)',
                color: on ? 'var(--acc)' : 'var(--t2)',
                border: `1.5px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`,
              }}>{ot}</button>
            );
          })}
        </div>
      </div>

      <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:12, color:'var(--t2)' }}>
        <input type="checkbox" checked={line.active !== false} onChange={e => set('active', e.target.checked)}/>
        Line is active
      </label>
    </div>
  );
}

// ── Draft -> engine-shaped profile. ONE builder shared by the live preview and
//    the Save gate, so what the operator saves is exactly what previewed.
function draftToProfile(draft) {
  const lines = (draft.lines || [])
    .filter(l => l.active !== false)
    .map((l, i) => ({
      id: l.id, name: l.name || 'Tax', jurisdiction: l.jurisdiction || null,
      lineType: l.lineType || 'rate',
      rate: Number(l.rate) || 0,
      flatAmount: Number(l.flatAmount) || 0,
      mode: l.mode === 'inclusive' ? 'inclusive' : 'exclusive',
      compound: l.compound === true,
      taxable: l.taxable === true,
      taxBasis: l.taxBasis || 'pre_discount',
      orderTypes: Array.isArray(l.orderTypes) && l.orderTypes.length ? l.orderTypes : ['all'],
      sortOrder: i,
      active: true,
    }));
  return {
    id: 'preview',
    name: draft.name || 'Preview',
    rounding: { mode:'half_up', level: draft.roundingLevel === 'item' ? 'item' : 'invoice' },
    lines,
  };
}

// ── Live preview (real engine, sample item, UI only) ─────────────────────────
function ProfilePreview({ draft }) {
  const [orderType, setOrderType] = useState('dine-in');

  const preview = useMemo(() => {
    const profile = draftToProfile(draft);
    const invalid = validateProfile(profile);
    if (invalid.length) return { error: invalid.join('; ') };
    try {
      const res = computeTax({
        lines: [{ price: 10, qty: 1, itemId: 'sample' }],
        profilesById: { preview: profile },
        resolveProfileId: () => 'preview',
        orderType,
        currencyMinorUnit: 2,
      });
      return { res };
    } catch (e) {
      return { error: e?.message || 'preview failed' };
    }
  }, [draft, orderType]);

  const fmt = n => (Number(n) || 0).toFixed(2);
  const res = preview.res;
  const totalCharged = res ? 10 + res.exclusiveTaxTotal : null;

  return (
    <div style={{ border:'1px solid var(--bdr)', borderRadius:12, padding:16, background:'var(--bg)', position:'sticky', top:0 }}>
      <div style={{ fontSize:12, fontWeight:800, color:'var(--t1)', marginBottom:2 }}>Live preview</div>
      <div style={{ fontSize:11, color:'var(--t4)', marginBottom:12, lineHeight:1.6 }}>
        A sample 10.00 item (£10.00 / $10.00), computed with the real tax engine. Preview only, no till uses this yet.
      </div>

      <label style={S.label}>Preview order type</label>
      <select style={{ ...S.select, marginBottom:12 }} value={orderType} onChange={e => setOrderType(e.target.value)}>
        {PROFILE_ORDER_TYPES.map(ot => <option key={ot} value={ot}>{ot}</option>)}
      </select>

      {preview.error && (
        <div style={{ padding:'8px 10px', borderRadius:8, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:11, lineHeight:1.5 }}>
          {preview.error}
        </div>
      )}

      {res && (
        <div style={{ fontSize:12, color:'var(--t2)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', color:'var(--t3)' }}>
            <span>Item price</span><span>10.00</span>
          </div>
          {res.lines.map(l => (
            <div key={l.lineId} style={{ display:'flex', justifyContent:'space-between', gap:8, padding:'4px 0', borderTop:'1px dashed var(--bdr)' }}>
              <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {l.name}{l.rate != null ? ` (${+(l.rate * 100).toFixed(4)}%)` : ''} {l.mode === 'inclusive' ? '· in price' : '· added'}
              </span>
              <span style={{ flexShrink:0 }}>{fmt(l.amount)}</span>
            </div>
          ))}
          {!res.lines.length && (
            <div style={{ padding:'6px 0', color:'var(--t4)', fontSize:11 }}>No lines apply to this order type.</div>
          )}
          <div style={{ display:'flex', justifyContent:'space-between', padding:'7px 0 3px', borderTop:'1px solid var(--bdr)', marginTop:6, fontWeight:800, color:'var(--t1)' }}>
            <span>Total charged</span><span>{fmt(totalCharged)}</span>
          </div>
          {res.inclusiveExtractedTotal > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', padding:'2px 0', fontSize:11, color:'var(--t4)' }}>
              <span>of which tax already in the price</span><span>{fmt(res.inclusiveExtractedTotal)}</span>
            </div>
          )}
          {res.exclusiveTaxTotal > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', padding:'2px 0', fontSize:11, color:'var(--t4)' }}>
              <span>tax added on top</span><span>{fmt(res.exclusiveTaxTotal)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Profile editor ───────────────────────────────────────────────────────────
function ProfileEditor({ profile, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => ({
    id: profile?.id || genId(),
    name: profile?.name || '',
    description: profile?.description || '',
    roundingLevel: profile?.rounding?.level === 'item' ? 'item' : 'invoice',
    active: profile?.active !== false,
    lines: (profile?.lines || []).map(l => ({ ...l })),
  }));
  const [removedLineIds, setRemovedLineIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const d = (k, v) => setDraft(p => ({ ...p, [k]: v }));

  const setLine = (i, next) => setDraft(p => ({ ...p, lines: p.lines.map((l, j) => j === i ? next : l) }));
  const removeLine = (i) => setDraft(p => {
    const l = p.lines[i];
    if (l?.id && (profile?.lines || []).some(x => x.id === l.id)) setRemovedLineIds(ids => [...ids, l.id]);
    return { ...p, lines: p.lines.filter((_, j) => j !== i) };
  });
  const moveLine = (i, dir) => setDraft(p => {
    const j = i + dir;
    if (j < 0 || j >= p.lines.length) return p;
    const lines = [...p.lines];
    [lines[i], lines[j]] = [lines[j], lines[i]];
    return { ...p, lines };
  });
  const addLine = () => setDraft(p => ({ ...p, lines: [...p.lines, {
    id: genId(), name:'', jurisdiction:'', lineType:'rate', rate:'', flatAmount:0,
    mode:'exclusive', compound:false, taxable:false, taxBasis:'pre_discount',
    orderTypes:['all'], active:true,
  }] }));

  const lineProblems = draft.lines
    .map((l, i) => !String(l.name || '').trim() ? `Line ${i + 1} needs a name` : null)
    .filter(Boolean);
  // v5.7.33 review fix: the engine's validator gates Save, so a profile the
  // engine would THROW on at cutover (per-unit inclusive) can never be stored.
  const engineProblems = validateProfile(draftToProfile(draft));
  const canSave = draft.name.trim() && !lineProblems.length && !engineProblems.length && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    await onSave(draft, removedLineIds);
    setSaving(false);
  };

  return (
    <div style={{ ...S.card, border:'1.5px solid var(--acc-b)' }}>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:16 }}>
        {profile?.id ? 'Edit tax profile' : 'New tax profile'}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:20, alignItems:'start' }}>
        <div>
          <div style={S.row}>
            <div>
              <label style={S.label}>Profile name *</label>
              <input style={S.input} value={draft.name} onChange={e => d('name', e.target.value)} placeholder="e.g. Standard food tax"/>
            </div>
            <div>
              <label style={S.label}>Rounding</label>
              <select style={S.select} value={draft.roundingLevel} onChange={e => d('roundingLevel', e.target.value)}>
                <option value="invoice">Per invoice: round each tax once across the whole order</option>
                <option value="item">Per item: round each order line, then add up</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Description</label>
            <input style={S.input} value={draft.description} onChange={e => d('description', e.target.value)} placeholder="What this profile is for (optional)"/>
          </div>

          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:13, color:'var(--t2)', marginBottom:16 }}>
            <input type="checkbox" checked={draft.active} onChange={e => d('active', e.target.checked)}/>
            Profile is active
          </label>

          <div style={{ fontSize:12, fontWeight:800, color:'var(--t1)', marginBottom:2 }}>Tax lines</div>
          <div style={{ fontSize:11, color:'var(--t4)', marginBottom:10, lineHeight:1.6 }}>
            Lines are worked out top to bottom. Order matters when a line compounds on the ones above it.
          </div>

          {draft.lines.map((l, i) => (
            <LineEditor key={l.id} line={l} index={i} count={draft.lines.length}
              onChange={next => setLine(i, next)}
              onRemove={() => removeLine(i)}
              onMove={dir => moveLine(i, dir)}/>
          ))}

          <button onClick={addLine} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px dashed var(--bdr)', width:'100%', padding:'10px' }}>
            + Add tax line
          </button>

          {lineProblems.length > 0 && (
            <div style={{ marginTop:10, fontSize:11, color:'var(--red)' }}>{lineProblems.join('. ')}.</div>
          )}

          <div style={{ display:'flex', gap:8, marginTop:16 }}>
            <button onClick={onCancel} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' }}>Cancel</button>
            <button onClick={handleSave} disabled={!canSave}
              style={{ ...S.btn, background:'var(--acc)', color:'#fff', opacity: canSave ? 1 : .5 }}>
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>

        <ProfilePreview draft={draft}/>
      </div>
    </div>
  );
}

// ── Profiles section ─────────────────────────────────────────────────────────
function TaxProfilesSection() {
  const [profiles, setProfiles] = useState([]);
  const [venueDefaultId, setVenueDefaultId] = useState(null);
  const [defaultDraft, setDefaultDraft] = useState(null);   // null = untouched
  const [savingDefault, setSavingDefault] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editId, setEditId] = useState(null);   // null | 'new' | uuid
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const load = async () => {
    setLoading(true);
    if (isMock) { setLoading(false); return; }
    const locId = await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') {
      setLoadFailed(true);
      setError('Could not resolve this location. Tax profiles were NOT loaded; reload before editing.');
      setLoading(false);
      return;
    }
    // Both table reads must succeed before anything is shown or applied: a
    // half-failed read must never present line-less profiles as editable truth.
    const [profQ, lineQ, locQ] = await Promise.all([
      supabase.from('tax_profiles').select('*').eq('location_id', locId).order('sort_order'),
      supabase.from('tax_profile_lines').select('*').eq('location_id', locId).order('sort_order'),
      supabase.from('locations').select('default_tax_profile_id').eq('id', locId).maybeSingle(),
    ]);
    if (profQ.error || lineQ.error || !Array.isArray(profQ.data) || !Array.isArray(lineQ.data)) {
      const m = profQ.error?.message || lineQ.error?.message || 'read failed';
      console.error('[TaxManager] profiles load failed:', m);
      setLoadFailed(true);
      setError(`Tax profiles could NOT be loaded (${m}). Nothing on this screen is live; reload before editing.`);
      setLoading(false);
      return;
    }
    const assembled = assembleTaxProfiles(profQ.data, lineQ.data);
    const defId = locQ.data ? (locQ.data.default_tax_profile_id || null) : null;
    setLoadFailed(false);
    setProfiles(assembled);
    setVenueDefaultId(defId);
    setDefaultDraft(null);
    // Sync the store so Push to POS snapshots carry what this screen just
    // confirmed from the DB (same convention as the legacy rates loader below).
    useStore.setState({ taxProfiles: assembled, ...(locQ.data ? { venueDefaultTaxProfileId: defId } : {}) });
    setLoading(false);
  };

  // Deferred a tick so no setState runs synchronously inside the effect body
  // (react-hooks/set-state-in-effect).
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, []);

  // ── Save one profile + its lines ───────────────────────────────────────────
  const handleSaveProfile = async (draft, removedLineIds) => {
    setError('');
    const locId = await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') { setError('No location ID. Nothing was saved.'); return; }

    const existing = profiles.find(p => p.id === draft.id);
    const rounding = { mode:'half_up', level: draft.roundingLevel === 'item' ? 'item' : 'invoice' };

    // 1. Profile row. Touched fields only: generated_from_rate_id, sort_order
    //    and created_at are never in the payload, so an edit can never clobber
    //    the "generated from your existing rate" stamp or the list order.
    if (existing) {
      const { data, error: err } = await supabase.from('tax_profiles')
        .update({ name: draft.name.trim(), description: draft.description.trim() || null, rounding, active: draft.active, updated_at: new Date().toISOString() })
        .eq('id', draft.id).eq('location_id', locId).select('id');
      const failure = err || (!data || data.length === 0 ? new Error('Update matched 0 rows. RLS blocked it or the profile no longer exists') : null);
      reportSave('tax profile', failure);
      if (failure) { setError(`"${draft.name}" was NOT saved (${failure.message}).`); return; }
    } else {
      const { data, error: err } = await supabase.from('tax_profiles')
        .insert({ id: draft.id, location_id: locId, name: draft.name.trim(), description: draft.description.trim() || null, rounding, active: draft.active, sort_order: profiles.length })
        .select('id');
      const failure = err || (!data || data.length === 0 ? new Error('Insert returned no row. RLS blocked it') : null);
      reportSave('tax profile', failure);
      if (failure) { setError(`"${draft.name}" was NOT saved (${failure.message}).`); return; }
    }

    // 2. Lines: explicit snake_case mapping, sort_order = position in the list.
    for (let i = 0; i < draft.lines.length; i++) {
      const l = draft.lines[i];
      const row = {
        id: l.id,
        profile_id: draft.id,
        location_id: locId,
        name: String(l.name || '').trim() || 'Tax',
        jurisdiction: String(l.jurisdiction || '').trim() || null,
        line_type: l.lineType === 'per_unit' ? 'per_unit' : 'rate',
        rate: Number(l.rate) || 0,
        flat_amount: Number(l.flatAmount) || 0,
        mode: l.mode === 'inclusive' ? 'inclusive' : 'exclusive',
        compound: l.compound === true,
        taxable: l.taxable === true,
        tax_basis: l.taxBasis === 'post_discount' ? 'post_discount' : 'pre_discount',
        order_types: Array.isArray(l.orderTypes) && l.orderTypes.length ? l.orderTypes : ['all'],
        sort_order: i,
        active: l.active !== false,
      };
      const { data, error: err } = await supabase.from('tax_profile_lines').upsert(row).select('id');
      const failure = err || (!data || data.length === 0 ? new Error('Line upsert returned no row. RLS blocked it') : null);
      reportSave('tax profile line', failure);
      if (failure) {
        setError(`Line ${i + 1} ("${row.name}") was NOT saved (${failure.message}). The profile row saved; fix the error and save again.`);
        await load();
        return;
      }
    }

    // 3. Removed lines. Scoped delete; an already-gone row is not an error.
    if (removedLineIds.length) {
      const { error: err } = await supabase.from('tax_profile_lines')
        .delete().in('id', removedLineIds).eq('profile_id', draft.id).eq('location_id', locId);
      reportSave('tax profile line delete', err);
      if (err) {
        setError(`Removed lines could not be deleted (${err.message}). The rest of the profile saved.`);
        await load();
        return;
      }
    }

    reportSave('tax profile', null);
    setEditId(null);
    flash('✓ Profile saved');
    await load();
  };

  // ── Delete a profile ───────────────────────────────────────────────────────
  const handleDeleteProfile = async (p) => {
    if (!confirm(`Delete the profile "${p.name}"? Items and categories assigned to it go back to inheriting, and if it is the venue default that is cleared too. Legacy rates keep charging exactly as today.`)) return;
    setError('');
    const locId = await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') { setError('No location ID. Nothing was deleted.'); return; }
    setDeleting(p.id);
    const { data, error: err } = await supabase.from('tax_profiles')
      .delete().eq('id', p.id).eq('location_id', locId).select('id');
    const failure = err || (!data || data.length === 0 ? new Error('Delete matched 0 rows. RLS blocked it') : null);
    reportSave('tax profile delete', failure);
    if (failure) {
      setDeleting(null);
      setError(`"${p.name}" was NOT deleted (${failure.message}). Nothing has changed.`);
      return;
    }
    // Referential hygiene: clear every assignment that pointed at the deleted
    // profile so nothing dangles (a dangling item assignment would stop the
    // cascade dead once calculations switch over). Lines cascade in the DB.
    const [itemsQ, catsQ, locQ] = await Promise.all([
      supabase.from('menu_items').update({ tax_profile_id: null }).eq('location_id', locId).eq('tax_profile_id', p.id),
      supabase.from('menu_categories').update({ tax_profile_id: null }).eq('location_id', locId).eq('tax_profile_id', p.id),
      venueDefaultId === p.id
        ? supabase.from('locations').update({ default_tax_profile_id: null }).eq('id', locId)
        : Promise.resolve({ error: null }),
    ]);
    const cleanupErr = itemsQ.error || catsQ.error || locQ.error;
    reportSave('tax profile unassign', cleanupErr);
    if (cleanupErr) setError(`The profile was deleted but some assignments could not be cleared (${cleanupErr.message}). Re-open the item or category and save to clear them.`);
    // Keep the store honest too, so a later item/category save cannot write the
    // deleted id back through the conditional tax_profile_id writers.
    useStore.setState(s => ({
      menuItems: (s.menuItems || []).map(i => i.taxProfileId === p.id ? { ...i, taxProfileId: null } : i),
      menuCategories: (s.menuCategories || []).map(c => c.taxProfileId === p.id ? { ...c, taxProfileId: null } : c),
      ...(s.venueDefaultTaxProfileId === p.id ? { venueDefaultTaxProfileId: null } : {}),
    }));
    setDeleting(null);
    if (!cleanupErr) flash('✓ Profile deleted');
    await load();
  };

  // ── Venue default ──────────────────────────────────────────────────────────
  const handleSaveDefault = async () => {
    if (defaultDraft === null || savingDefault) return;
    setError('');
    const locId = await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') { setError('No location ID. The default was not changed.'); return; }
    setSavingDefault(true);
    // Single-column update: merged into the locations row, never a clobber.
    const { data, error: err } = await supabase.from('locations')
      .update({ default_tax_profile_id: defaultDraft || null }).eq('id', locId).select('id');
    setSavingDefault(false);
    const failure = err || (!data || data.length === 0 ? new Error('Update matched 0 rows. RLS blocked it') : null);
    reportSave('venue default tax profile', failure);
    if (failure) { setError(`The venue default was NOT changed (${failure.message}).`); return; }
    setVenueDefaultId(defaultDraft || null);
    setDefaultDraft(null);
    useStore.setState({ venueDefaultTaxProfileId: defaultDraft || null });
    flash('✓ Venue default saved');
  };

  const activeProfiles = profiles.filter(p => p.active !== false);
  const defaultValue = defaultDraft !== null ? defaultDraft : (venueDefaultId || '');

  const lineSummary = (p) => (p.lines || []).map(l =>
    l.lineType === 'per_unit'
      ? `${l.name} (flat ${(Number(l.flatAmount) || 0).toFixed(2)}/unit)`
      : `${l.name} ${+(Number(l.rate) * 100).toFixed(4)}% ${l.mode === 'inclusive' ? 'incl.' : 'excl.'}`
  ).join(' + ') || 'No lines';

  if (isMock) return <div style={{ color:'var(--t4)', fontSize:13, padding:'20px 0' }}>Tax profiles need a live database connection.</div>;

  return (
    <div>
      {/* The quiet banner: profiles are setup-only until the calculation cutover */}
      <div style={{ padding:'10px 14px', borderRadius:10, background:'var(--bg1)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:12, lineHeight:1.7, marginBottom:18 }}>
        Profiles are live for setup. Tills switch to profile-based calculation in an upcoming update; until then legacy rates keep charging exactly as today.
      </div>

      {msg   && <div style={{ padding:'10px 14px', borderRadius:8, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)', fontSize:13, marginBottom:12 }}>{msg}</div>}
      {error && <div style={{ padding:'10px 14px', borderRadius:8, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:13, marginBottom:12 }}>{error}</div>}

      {loading ? (
        <div style={{ color:'var(--t4)', fontSize:13, padding:'20px 0' }}>Loading…</div>
      ) : loadFailed ? null : (
        <>
          {/* Venue default profile */}
          <div style={{ ...S.card, display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
            <div style={{ flex:1, minWidth:220 }}>
              <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:3 }}>Venue default profile</div>
              <div style={{ fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>
                Used when an item and its category have no profile of their own. With no default set, the legacy default rate applies.
              </div>
            </div>
            <select style={{ ...S.select, width:280 }} value={defaultValue}
              onChange={e => setDefaultDraft(e.target.value)}>
              <option value="">None (use the legacy default rate)</option>
              {activeProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {defaultDraft !== null && defaultDraft !== (venueDefaultId || '') && (
              <button onClick={handleSaveDefault} disabled={savingDefault}
                style={{ ...S.btn, background:'var(--acc)', color:'#fff', opacity: savingDefault ? .6 : 1 }}>
                {savingDefault ? 'Saving…' : 'Save default'}
              </button>
            )}
          </div>

          {/* Profile list */}
          {profiles.map(p => {
            if (editId === p.id) return <ProfileEditor key={p.id} profile={p} onSave={handleSaveProfile} onCancel={() => setEditId(null)}/>;
            return (
              <div key={p.id} style={{ ...S.card, display:'flex', alignItems:'center', gap:16 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{p.name}</span>
                    {p.id === venueDefaultId && <span style={{ ...S.badge, background:'var(--grn-d)', color:'var(--grn)', border:'1px solid var(--grn-b)' }}>Venue default</span>}
                    {p.generatedFromRateId && <span style={{ ...S.badge, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>Generated from your existing rate</span>}
                    {p.active === false && <span style={{ ...S.badge, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>Inactive</span>}
                  </div>
                  <div style={{ fontSize:12, color:'var(--t4)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {lineSummary(p)} · rounds per {p.rounding?.level === 'item' ? 'item' : 'invoice'}
                    {p.description ? ` · ${p.description}` : ''}
                  </div>
                </div>
                <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                  <button onClick={() => setEditId(p.id)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', padding:'7px 14px', fontSize:12 }}>Edit</button>
                  <button onClick={() => handleDeleteProfile(p)} disabled={deleting === p.id}
                    style={{ ...S.btn, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', padding:'7px 14px', fontSize:12 }}>
                    {deleting === p.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}

          {!profiles.length && (
            <div style={{ ...S.card, color:'var(--t4)', fontSize:13, lineHeight:1.7 }}>
              No tax profiles yet. Your legacy rates keep working; create a profile when you need stacked or jurisdiction-specific taxes.
            </div>
          )}

          {editId === 'new' && <ProfileEditor onSave={handleSaveProfile} onCancel={() => setEditId(null)}/>}

          {!editId && (
            <button onClick={() => setEditId('new')}
              style={{ ...S.btn, background:'var(--acc)', color:'#fff', padding:'10px 20px', marginTop:4 }}>
              + New tax profile
            </button>
          )}

          <div style={{ marginTop:20, padding:'12px 16px', borderRadius:10, background:'var(--bg3)', border:'1px solid var(--bdr)', fontSize:12, color:'var(--t4)', lineHeight:1.8 }}>
            <strong style={{ color:'var(--t2)' }}>Assigning profiles:</strong> Menu Manager → edit a category → Tax profile, or edit an item → Tax → Tax profile (override).
            The cascade is item override, then item legacy rate, then category profile, then the venue default above, then the legacy default rate.
          </div>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LEGACY RATES — the pre-profiles per-rate UI, unchanged behaviour. These rates
// are what every till and customer page still charges with today.
// ═════════════════════════════════════════════════════════════════════════════

function RateBadge({ rate }) {
  const pct = (parseFloat(rate.rate || 0) * 100).toFixed(1).replace('.0','');
  const isInc = rate.type === 'inclusive';
  return (
    <span style={{ ...S.badge, background: isInc ? 'var(--acc-d)' : 'var(--grn-d)', color: isInc ? 'var(--acc)' : 'var(--grn)', border:`1px solid ${isInc ? 'var(--acc-b)' : 'var(--grn-b)'}` }}>
      {pct}% {isInc ? 'incl.' : 'excl.'}
    </span>
  );
}

function RateForm({ rate, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...rate });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);

  const toggleOrderType = (ot) => {
    if (form.applies_to.includes('all')) {
      f('applies_to', [ot]);
    } else if (form.applies_to.includes(ot)) {
      const next = form.applies_to.filter(x => x !== ot);
      f('applies_to', next.length ? next : ['all']);
    } else {
      f('applies_to', [...form.applies_to, ot]);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim() || form.rate === '') return;
    setSaving(true);
    await onSave({ ...form, rate: parseFloat(form.rate) });
    setSaving(false);
  };

  return (
    <div style={{ ...S.card, border:'1.5px solid var(--acc-b)', background:'var(--acc-d)' }}>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:16 }}>
        {rate?.id ? 'Edit tax rate' : 'Add tax rate'}
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Name *</label>
          <input style={S.input} value={form.name} onChange={e => f('name', e.target.value)} placeholder="e.g. Standard Rate"/>
        </div>
        <div>
          <label style={S.label}>Code</label>
          <input style={S.input} value={form.code} onChange={e => f('code', e.target.value)} placeholder="e.g. VAT20"/>
        </div>
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Rate %</label>
          <input style={S.input} type="number" min="0" max="100" step="0.001"
            value={form.rate === '' ? '' : parseFloat(form.rate) * 100}
            onChange={e => f('rate', e.target.value === '' ? '' : parseFloat(e.target.value) / 100)}
            placeholder="e.g. 20"/>
        </div>
        <div>
          <label style={S.label}>Tax model</label>
          <select style={S.select} value={form.type} onChange={e => f('type', e.target.value)}>
            <option value="inclusive">Inclusive — tax is in the price (UK VAT)</option>
            <option value="exclusive">Exclusive — tax added on top (US Sales Tax)</option>
          </select>
        </div>
      </div>

      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Applies to order types</label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          <button onClick={() => f('applies_to', ['all'])} style={{
            ...S.btn, padding:'5px 12px',
            background: form.applies_to.includes('all') ? 'var(--acc)' : 'var(--bg3)',
            color: form.applies_to.includes('all') ? '#fff' : 'var(--t2)',
            border: `1.5px solid ${form.applies_to.includes('all') ? 'var(--acc)' : 'var(--bdr)'}`,
          }}>All types</button>
          {ORDER_TYPES.map(ot => (
            <button key={ot} onClick={() => toggleOrderType(ot)} style={{
              ...S.btn, padding:'5px 12px',
              background: !form.applies_to.includes('all') && form.applies_to.includes(ot) ? 'var(--acc-d)' : 'var(--bg3)',
              color: !form.applies_to.includes('all') && form.applies_to.includes(ot) ? 'var(--acc)' : 'var(--t2)',
              border: `1.5px solid ${!form.applies_to.includes('all') && form.applies_to.includes(ot) ? 'var(--acc-b)' : 'var(--bdr)'}`,
            }}>{ot}</button>
          ))}
        </div>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:14 }}>
        <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:13, color:'var(--t2)' }}>
          <input type="checkbox" checked={form.is_default} onChange={e => f('is_default', e.target.checked)}/>
          Default rate — applied to new menu items automatically
        </label>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button onClick={onCancel} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' }}>Cancel</button>
        <button onClick={handleSave} disabled={saving || !form.name.trim() || form.rate === ''}
          style={{ ...S.btn, background:'var(--acc)', color:'#fff', opacity: saving ? .6 : 1 }}>
          {saving ? 'Saving…' : 'Save rate'}
        </button>
      </div>
    </div>
  );
}

function LegacyRatesSection() {
  const [rates, setRates]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId]   = useState(null);   // null | 'new' | uuid
  const [deleting, setDeleting] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError]     = useState('');
  const [msg, setMsg]         = useState('');

  // VAT is HMRC-relevant, so a read that didn't work must never be mistaken for "this venue
  // charges no tax": the old version discarded the read error, pushed a possibly-EMPTY table
  // into the running POS and re-offered the Seed buttons, inviting a duplicate set of rates.
  // `expectEmpty` is passed by the delete path, which is the only place zero rows is news.
  const load = async ({ expectEmpty = false } = {}) => {
    setLoading(true);
    if (isMock) { setLoading(false); return; }
    const locId = await getLocationId().catch(() => null);
    if (!locId) {
      setLoadFailed(true);
      setError('Could not resolve this location — tax rates were NOT loaded. Nothing on this screen is live; reload before editing.');
      setLoading(false);
      return;
    }
    const { data, error: err } = await supabase.from('tax_rates').select('*').eq('location_id', locId).order('rate', { ascending:false });
    if (err) {
      console.error('[TaxManager] load failed:', err.message);
      setLoadFailed(true);
      setError(`Tax rates could NOT be loaded — ${err.message}. The till is still using the rates it already has; do not re-seed.`);
      setLoading(false);
      return;
    }
    const fetched = data || [];
    // A tightened RLS SELECT policy returns zero rows with NO error. Silently publishing that
    // would switch the running POS to "no tax" mid-service.
    if (!fetched.length && !expectEmpty && (useStore.getState().taxRates || []).length) {
      setLoadFailed(true);
      setError('Tax rates came back EMPTY while the till still has rates loaded — not applying them. Check your sign-in/access before seeding anything.');
      setLoading(false);
      return;
    }
    setLoadFailed(false);
    setRates(fetched);
    // Sync to Zustand store so POS/checkout/order panel pick up name changes immediately
    useStore.setState({ taxRates: fetched.map(r => ({
      id: r.id, name: r.name, code: r.code,
      rate: parseFloat(r.rate), type: r.type,
      appliesTo: r.applies_to || ['all'],
      isDefault: r.is_default, active: r.active,
    })) });
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const handleSave = async (form) => {
    setError('');
    const locId = await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') { setError('No location ID — nothing was saved.'); return; }

    // If setting as default, unset all others first
    let clearedDefaults = false;
    if (form.is_default) {
      const { data: cleared, error: unsetErr } = await supabase
        .from('tax_rates').update({ is_default:false }).eq('location_id', locId).select('id');
      // Zero rows means the update was blocked (this matches EVERY rate at the location), and
      // carrying on would leave two rows flagged default — an ambiguous tax table. Only a venue
      // with no rates yet legitimately matches nothing.
      const unsetFailed = unsetErr || (rates.length > 0 && (!cleared || cleared.length === 0)
        ? new Error('Clearing the previous default matched 0 rows — RLS blocked it') : null);
      reportSave('tax rates', unsetFailed);
      if (unsetFailed) {
        setError(`Nothing was saved — the previous default rate could not be cleared (${unsetFailed.message}).`);
        return;
      }
      clearedDefaults = (cleared || []).length > 0;
    }

    // If the write below fails after the defaults were cleared, the venue is left with NO
    // default rate — say so explicitly rather than leaving it to be discovered at the till.
    const tail = clearedDefaults ? ' The previous default was already cleared — set a default rate before taking payments.' : '';

    if (form.id) {
      const { data, error: err } = await supabase.from('tax_rates').update({ ...form, location_id:locId }).eq('id', form.id).select('id');
      const failure = err || (!data || data.length === 0 ? new Error('Update matched 0 rows — RLS blocked it or the rate no longer exists') : null);
      reportSave('tax rate', failure);
      if (failure) { setError(`"${form.name}" was NOT saved — ${failure.message}.${tail}`); return; }
    } else {
      const { data, error: err } = await supabase.from('tax_rates').insert({ ...form, location_id:locId }).select('id');
      const failure = err || (!data || data.length === 0 ? new Error('Insert returned no row — RLS blocked it') : null);
      reportSave('tax rate', failure);
      if (failure) { setError(`"${form.name}" was NOT saved — ${failure.message}.${tail}`); return; }
    }
    reportSave('tax rate', null);
    setEditId(null);
    flash('✓ Saved');
    await load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this tax rate? Items assigned to it will lose their tax setting.')) return;
    setError('');
    setDeleting(id);
    const { data, error: err } = await supabase.from('tax_rates').delete().eq('id', id).select('id');
    setDeleting(null);
    const failure = err || (!data || data.length === 0 ? new Error('Delete matched 0 rows — RLS blocked it') : null);
    reportSave('tax rate delete', failure);
    if (failure) {
      setError(`Tax rate was NOT deleted — ${failure.message}. Nothing has changed.`);
      return;
    }
    // The only place an empty tax table is expected news.
    await load({ expectEmpty: true });
  };

  const seedRates = async (defaults) => {
    if (seeding) return;
    setError('');
    const locId = await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') { setError('Could not resolve this location — no rates were added.'); return; }
    setSeeding(true);
    // Was a bare loop of unchecked inserts followed by an unconditional "✓ N rates added" —
    // a blocked insert left a half-seeded (or completely empty) tax table looking complete.
    let added = 0;
    for (const r of defaults) {
      const { data, error: err } = await supabase.from('tax_rates').insert({ ...r, location_id: locId }).select('id');
      const failure = err || (!data || data.length === 0 ? new Error('Insert returned no row — RLS blocked it') : null);
      if (failure) {
        reportSave('tax rates', failure);
        setSeeding(false);
        setError(`Only ${added} of ${defaults.length} rates were added — ${failure.message}. Delete any partial rates, fix the error, then seed again.`);
        await load();
        return;
      }
      added++;
    }
    reportSave('tax rates', null);
    setSeeding(false);
    flash(`✓ ${defaults.length} rates added`);
    await load();
  };

  return (
    <div>
      <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>Legacy rates</div>
      {/* v5.7.33: profiles are the new way; these rates still do the charging */}
      <div style={{ padding:'10px 14px', borderRadius:10, background:'var(--bg1)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:12, lineHeight:1.7, marginBottom:18 }}>
        Tax profiles (the tab above) are the new way to set up tax and will take over calculation in an upcoming update.
        These legacy rates still work and are what every till and customer page charges with today, so keep them correct.
      </div>

      {/* Info panels */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:24 }}>
        <div style={{ padding:'14px 16px', borderRadius:12, background:'var(--bg1)', border:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>🇬🇧 UK VAT (Inclusive)</div>
          <div style={{ fontSize:12, color:'var(--t4)', lineHeight:1.7 }}>
            Price shown on POS includes tax. VAT is extracted at checkout. Standard 20%, Reduced 5%, Zero 0%.
            Items can be zero-rated for takeaway but standard-rated for dine-in.
          </div>
          {/* Only offered when we KNOW the table is empty — after a failed read it would seed a
              duplicate set on top of rates that are already there. */}
          {!rates.length && !loading && !loadFailed && (
            <button onClick={() => seedRates(UK_DEFAULT_RATES)} disabled={seeding}
              style={{ ...S.btn, background:'var(--acc)', color:'#fff', marginTop:10, padding:'7px 14px', fontSize:12, opacity: seeding ? .6 : 1 }}>
              {seeding ? 'Adding…' : 'Seed UK rates'}
            </button>
          )}
        </div>
        <div style={{ padding:'14px 16px', borderRadius:12, background:'var(--bg1)', border:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>🇺🇸 US Sales Tax (Exclusive)</div>
          <div style={{ fontSize:12, color:'var(--t4)', lineHeight:1.7 }}>
            Tax is added on top of the item price at checkout. Rate varies by state/city.
            The customer-facing total is subtotal + tax.
          </div>
          {!rates.length && !loading && !loadFailed && (
            <button onClick={() => seedRates(US_DEFAULT_RATES)} disabled={seeding}
              style={{ ...S.btn, background:'var(--acc)', color:'#fff', marginTop:10, padding:'7px 14px', fontSize:12, opacity: seeding ? .6 : 1 }}>
              {seeding ? 'Adding…' : 'Seed US rates'}
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      {msg   && <div style={{ padding:'10px 14px', borderRadius:8, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)', fontSize:13, marginBottom:12 }}>{msg}</div>}
      {error && <div style={{ padding:'10px 14px', borderRadius:8, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:13, marginBottom:12 }}>{error}</div>}

      {/* Rates list */}
      {loading ? (
        <div style={{ color:'var(--t4)', fontSize:13, padding:'20px 0' }}>Loading…</div>
      ) : (
        <>
          {rates.map(rate => {
            if (editId === rate.id) return <RateForm key={rate.id} rate={rate} onSave={handleSave} onCancel={() => setEditId(null)}/>;
            const pct = (parseFloat(rate.rate) * 100).toFixed(rate.rate % 0.01 === 0 ? 0 : 3).replace(/\.?0+$/, '');
            return (
              <div key={rate.id} style={{ ...S.card, display:'flex', alignItems:'center', gap:16 }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{rate.name}</span>
                    <RateBadge rate={rate}/>
                    {rate.is_default && <span style={{ ...S.badge, background:'var(--grn-d)', color:'var(--grn)', border:'1px solid var(--grn-b)' }}>Default</span>}
                    {!rate.active && <span style={{ ...S.badge, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>Inactive</span>}
                  </div>
                  <div style={{ fontSize:12, color:'var(--t4)' }}>
                    {pct}% · {rate.type === 'inclusive' ? 'Tax included in price' : 'Tax added on top'} ·
                    {' '}{rate.code && <span style={{ fontFamily:'monospace' }}>{rate.code}</span>}
                    {' '}· Applies to: {(rate.applies_to || ['all']).join(', ')}
                  </div>
                </div>
                <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                  <button onClick={() => setEditId(rate.id)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', padding:'7px 14px', fontSize:12 }}>Edit</button>
                  <button onClick={() => handleDelete(rate.id)} disabled={deleting === rate.id}
                    style={{ ...S.btn, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', padding:'7px 14px', fontSize:12 }}>
                    {deleting === rate.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}

          {/* New rate form */}
          {editId === 'new' && <RateForm onSave={handleSave} onCancel={() => setEditId(null)}/>}

          {/* Add button */}
          {!editId && (
            <button onClick={() => setEditId('new')}
              style={{ ...S.btn, background:'var(--acc)', color:'#fff', padding:'10px 20px', marginTop:4 }}>
              + Add tax rate
            </button>
          )}

          {rates.length > 0 && (
            <div style={{ marginTop:20, padding:'12px 16px', borderRadius:10, background:'var(--bg3)', border:'1px solid var(--bdr)', fontSize:12, color:'var(--t4)', lineHeight:1.8 }}>
              <strong style={{ color:'var(--t2)' }}>Next steps:</strong> Go to Menu Manager → select an item → assign a tax rate.
              You can set different rates per order type (e.g. a burger is 20% dine-in but 0% takeaway).
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Root — Tax & VAT with two sections: the new profiles builder and the legacy
// per-rate UI that still powers every calculation today.
// ═════════════════════════════════════════════════════════════════════════════
export default function TaxManager() {
  const [tab, setTab] = useState('profiles');
  return (
    <div style={S.page}>
      <div style={S.h1}>Tax & VAT</div>
      <div style={S.sub}>Set up tax profiles for this location, assign them to categories and items, and manage the legacy rates that currently charge.</div>

      <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--bdr)', marginBottom:20 }}>
        {[['profiles','Tax profiles'],['legacy','Legacy rates']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding:'10px 18px', cursor:'pointer', fontFamily:'inherit', border:'none',
            borderBottom:`3px solid ${tab === id ? 'var(--acc)' : 'transparent'}`,
            background:'transparent', color: tab === id ? 'var(--acc)' : 'var(--t3)',
            fontSize:13, fontWeight: tab === id ? 800 : 500,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'profiles' && <TaxProfilesSection/>}
      {tab === 'legacy'   && <LegacyRatesSection/>}
    </div>
  );
}
