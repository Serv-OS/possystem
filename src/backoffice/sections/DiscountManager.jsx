import { useState, useEffect } from 'react';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { useStore } from '../../store';
import { reportSave } from '../../lib/saveHealth';
// Static imports — a click-time dynamic import can fail silently in the Vite bundle, and the
// old try/catch around it swallowed that too (CLAUDE.md: static imports only).
import { upsertDiscount, deleteDiscount, upsertDiscountRule, deleteDiscountRule } from '../../lib/db';
import { money, currencySymbol } from '../../lib/currency';

/* ── Style constants (match TaxManager / LocationSettings pattern) ────────── */
const S = {
  page:   { padding:'32px 40px', maxWidth:920 },
  h1:     { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub:    { fontSize:13, color:'var(--t3)', marginBottom:28 },
  card:   { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:22, marginBottom:12 },
  h2:     { fontSize:16, fontWeight:700, color:'var(--t1)', marginBottom:6 },
  desc:   { fontSize:12, color:'var(--t3)', marginBottom:18 },
  label:  { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input:  { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  select: { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  btn:    { padding:'9px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  row:    { display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 },
  badge:  { padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700 },
  toggle: (on) => ({
    width:40, height:22, borderRadius:11, border:'none', cursor:'pointer',
    background: on ? 'var(--acc)' : 'var(--bg4)', position:'relative', transition:'background .2s',
  }),
  toggleDot: (on) => ({
    position:'absolute', top:3, left: on ? 21 : 3,
    width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s',
  }),
};

const EMPTY_DISCOUNT = {
  name:'', type:'percent', value:'', scope:'global', categoryIds:[], requiresManager:false, active:true,
};

const EMPTY_RULE = {
  name:'', active:true,
  triggerType:'buy_x', triggerCategoryIds:[], triggerQty:2,
  triggerGroups: [{ categoryIds: [], qty: 1 }],
  rewardType:'percent', rewardValue:'', rewardQty:1, rewardCategoryIds:[],
  channels:{ pos:true, online:true, qr:true, kiosk:true },
  // When it applies. Empty = always on. days: ISO weekday 1=Mon..7=Sun.
  // windows: [{start:'HH:MM', end:'HH:MM'}]. startsAt/expiresAt: 'YYYY-MM-DD' (inclusive).
  schedule:{ days:[], windows:[], startsAt:'', expiresAt:'' },
};

const EMPTY_TRIGGER_GROUP = { categoryIds: [], qty: 1 };
// ISO weekday order for the day picker (1=Mon .. 7=Sun), matches discountEngine.isRuleActiveNow.
const DOW = [[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri'],[6,'Sat'],[7,'Sun']];
const normaliseSchedule = (s) => ({
  days: Array.isArray(s?.days) ? s.days : [],
  windows: Array.isArray(s?.windows) ? s.windows : [],
  startsAt: s?.startsAt || '',
  expiresAt: s?.expiresAt || '',
});
// Human one-liner for the rule card (empty string when the rule is always-on).
const scheduleSummary = (s) => {
  if (!s) return '';
  const map = { 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat', 7:'Sun' };
  const parts = [];
  if (Array.isArray(s.days) && s.days.length && s.days.length < 7) {
    parts.push(s.days.slice().sort((a,b)=>a-b).map(d => map[d]).join(', '));
  }
  const w = (s.windows || [])[0];
  if (w?.start && w?.end) parts.push(`${w.start}–${w.end}`);
  if (s.startsAt) parts.push(`from ${s.startsAt}`);
  if (s.expiresAt) parts.push(`until ${s.expiresAt}`);
  return parts.join(' · ');
};

const CHANNEL_LABELS = { pos:'POS', online:'Online ordering', qr:'QR code ordering', kiosk:'Kiosk' };

/* ── Sub-components ───────────────────────────────────────────────────────── */

function Toggle({ value, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!value)} style={S.toggle(value)}>
      <div style={S.toggleDot(value)} />
    </button>
  );
}

function CategoryPicker({ selected, onChange, categories }) {
  const [open, setOpen] = useState(false);
  const toggle = (id) => {
    const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
    onChange(next);
  };
  const selectedLabels = categories.filter(c => selected.includes(c.id)).map(c => c.label);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} style={{
        ...S.input, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between',
        color: selectedLabels.length ? 'var(--t1)' : 'var(--t3)',
      }}>
        <span>{selectedLabels.length ? selectedLabels.join(', ') : 'Select categories...'}</span>
        <span style={{ fontSize:10 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ border:'1px solid var(--bdr)', borderRadius:8, background:'var(--bg1)', marginTop:4, maxHeight:200, overflowY:'auto', padding:4 }}>
          {categories.map(cat => (
            <div key={cat.id} onClick={() => toggle(cat.id)} style={{
              display:'flex', alignItems:'center', gap:8, padding:'6px 10px', borderRadius:6,
              cursor:'pointer', background: selected.includes(cat.id) ? 'var(--acc-d)' : 'transparent',
            }}>
              <div style={{
                width:16, height:16, borderRadius:4, flexShrink:0,
                border:`2px solid ${selected.includes(cat.id) ? 'var(--acc)' : 'var(--bdr2)'}`,
                background: selected.includes(cat.id) ? 'var(--acc)' : 'transparent',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                {selected.includes(cat.id) && <div style={{ width:8, height:8, borderRadius:2, background:'#fff' }} />}
              </div>
              <span style={{ fontSize:12, color:'var(--t1)' }}>{cat.icon} {cat.label}</span>
            </div>
          ))}
          {!categories.length && <div style={{ padding:10, fontSize:12, color:'var(--t3)' }}>No categories found</div>}
        </div>
      )}
    </div>
  );
}

/* ── Discount Preset Form ─────────────────────────────────────────────────── */

function DiscountForm({ discount, categories, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY_DISCOUNT, ...discount, value: discount?.value ?? '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.name.trim() || form.value === '') return;
    setSaving(true);
    await onSave({ ...form, value: parseFloat(form.value) || 0 });
    setSaving(false);
  };

  return (
    <div style={{ ...S.card, border:'1.5px solid var(--acc-b)', background:'var(--acc-d)' }}>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:16 }}>
        {discount?.id ? 'Edit discount' : 'Add discount'}
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Discount name</label>
          <input style={S.input} value={form.name} onChange={e => f('name', e.target.value)} placeholder="e.g. Staff meal" />
        </div>
        <div>
          <label style={S.label}>Type</label>
          <select style={S.select} value={form.type} onChange={e => f('type', e.target.value)}>
            <option value="percent">Percentage (%)</option>
            <option value="amount">Fixed amount (£)</option>
          </select>
        </div>
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Value</label>
          <input style={S.input} type="number" min="0" value={form.value}
            onChange={e => f('value', e.target.value)}
            placeholder={form.type === 'percent' ? 'e.g. 20' : 'e.g. 5.00'} />
        </div>
        <div>
          <label style={S.label}>Scope</label>
          <select style={S.select} value={form.scope} onChange={e => f('scope', e.target.value)}>
            <option value="global">All items (global)</option>
            <option value="category">Specific categories</option>
          </select>
        </div>
      </div>

      {form.scope === 'category' && (
        <div style={{ marginBottom:14 }}>
          <label style={S.label}>Categories</label>
          <CategoryPicker selected={form.categoryIds} onChange={v => f('categoryIds', v)} categories={categories} />
        </div>
      )}

      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18 }}>
        <label style={{ ...S.label, marginBottom:0 }}>Requires manager PIN</label>
        <Toggle value={form.requiresManager} onChange={v => f('requiresManager', v)} />
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)' }} onClick={onCancel}>Cancel</button>
        <button style={{ ...S.btn, background:'var(--acc)', color:'#0e0f14' }} onClick={handleSave}
          disabled={saving || !form.name.trim() || form.value === ''}>
          {saving ? 'Saving...' : 'Save discount'}
        </button>
      </div>
    </div>
  );
}

/* ── Auto-Discount Rule Form ──────────────────────────────────────────────── */

function RuleForm({ rule, categories, onSave, onCancel }) {
  const [form, setForm] = useState({
    ...EMPTY_RULE, ...rule,
    rewardValue: rule?.rewardValue ?? '',
    triggerQty: rule?.triggerQty ?? 2,
    rewardQty: rule?.rewardQty ?? 1,
    triggerGroups: rule?.triggerGroups?.length ? rule.triggerGroups : [{ ...EMPTY_TRIGGER_GROUP }],
    schedule: normaliseSchedule(rule?.schedule),
  });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  // Schedule helpers (day toggles + a single optional time window + start/expiry dates)
  const sched = form.schedule || normaliseSchedule(null);
  const setSched = (patch) => f('schedule', { ...sched, ...patch });
  const toggleDay = (d) => setSched({ days: sched.days.includes(d) ? sched.days.filter(x => x !== d) : [...sched.days, d].sort((a,b)=>a-b) });
  const win = sched.windows[0] || { start:'', end:'' };
  const setWindow = (patch) => {
    const next = { ...win, ...patch };
    setSched({ windows: (next.start || next.end) ? [next] : [] });
  };
  const [saving, setSaving] = useState(false);
  const [sameRewardCats, setSameRewardCats] = useState(
    !rule?.rewardCategoryIds?.length || JSON.stringify(rule?.rewardCategoryIds) === JSON.stringify(rule?.triggerCategoryIds)
  );

  const isBundle = form.triggerType === 'bundle';

  const toggleChannel = (ch) => {
    f('channels', { ...form.channels, [ch]: !form.channels[ch] });
  };

  // ── Trigger group helpers (for bundle mode) ──
  const updateGroup = (idx, patch) => {
    const next = form.triggerGroups.map((g, i) => i === idx ? { ...g, ...patch } : g);
    f('triggerGroups', next);
  };
  const addGroup = () => f('triggerGroups', [...form.triggerGroups, { ...EMPTY_TRIGGER_GROUP }]);
  const removeGroup = (idx) => {
    if (form.triggerGroups.length <= 1) return;
    f('triggerGroups', form.triggerGroups.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    // Clean the schedule: drop blank windows; store null when nothing is set ("always on").
    const cleanWindows = (sched.windows || []).filter(w => w && w.start && w.end);
    const hasSchedule = (sched.days?.length > 0) || cleanWindows.length > 0 || sched.startsAt || sched.expiresAt;
    const schedulePayload = hasSchedule
      ? { days: sched.days || [], windows: cleanWindows, startsAt: sched.startsAt || null, expiresAt: sched.expiresAt || null }
      : null;
    const payload = {
      ...form,
      rewardValue: parseFloat(form.rewardValue) || 0,
      triggerQty: parseInt(form.triggerQty) || 2,
      rewardQty: parseInt(form.rewardQty) || 1,
      rewardCategoryIds: sameRewardCats ? [] : form.rewardCategoryIds,
      schedule: schedulePayload,
      // For bundle type, set reward type to fixed_price automatically
      ...(isBundle ? { rewardType: 'fixed_price', rewardQty: 0 } : {}),
      // Only include triggerGroups for bundle type
      triggerGroups: isBundle ? form.triggerGroups : null,
    };
    await onSave(payload);
    setSaving(false);
  };

  // Build human-readable summary
  let summary;
  if (isBundle) {
    const groupParts = form.triggerGroups.map(g => {
      const names = categories.filter(c => g.categoryIds.includes(c.id)).map(c => c.label).join(', ') || 'any';
      return `${g.qty} from ${names}`;
    });
    summary = `${groupParts.join(' + ')} = ${currencySymbol()}${form.rewardValue || '?'}`;
  } else {
    const triggerCatNames = categories.filter(c => form.triggerCategoryIds.includes(c.id)).map(c => c.label).join(', ') || 'any category';
    const rewardLabel = form.rewardType === 'free' ? 'free'
      : form.rewardType === 'percent' ? `${form.rewardValue || '?'}% off`
      : `${currencySymbol()}${form.rewardValue || '?'} off`;
    summary = `Buy ${form.triggerQty} from ${triggerCatNames}, get ${form.rewardQty} ${rewardLabel}`;
  }

  return (
    <div style={{ ...S.card, border:'1.5px solid var(--acc-b)', background:'var(--acc-d)' }}>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>
        {rule?.id ? 'Edit auto-discount rule' : 'Add auto-discount rule'}
      </div>
      <div style={{ fontSize:11, color:'var(--t3)', marginBottom:16, fontStyle:'italic' }}>{summary}</div>

      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Rule name</label>
        <input style={S.input} value={form.name} onChange={e => f('name', e.target.value)}
          placeholder={isBundle ? 'e.g. Lunch deal — starter + main + drink £15' : 'e.g. Buy 2 pizzas get 3rd 50% off'} />
      </div>

      {/* Rule type selector */}
      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Rule type</label>
        <div style={{ display:'flex', gap:6 }}>
          {[['buy_x','Buy X get Y'],['bundle','Bundle / Meal deal']].map(([val, label]) => (
            <button key={val} type="button" onClick={() => f('triggerType', val)} style={{
              flex:1, padding:'10px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
              fontSize:12, fontWeight:700, textAlign:'center',
              border:`1.5px solid ${form.triggerType === val ? 'var(--acc)' : 'var(--bdr)'}`,
              background: form.triggerType === val ? 'var(--acc-d)' : 'var(--bg3)',
              color: form.triggerType === val ? 'var(--acc)' : 'var(--t2)',
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Buy-X trigger ── */}
      {!isBundle && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:10 }}>Trigger condition</div>
          <div style={S.row}>
            <div>
              <label style={S.label}>Buy quantity</label>
              <input style={S.input} type="number" min="1" value={form.triggerQty}
                onChange={e => f('triggerQty', e.target.value)} />
            </div>
            <div>
              <label style={S.label}>From categories</label>
              <CategoryPicker selected={form.triggerCategoryIds} onChange={v => f('triggerCategoryIds', v)} categories={categories} />
            </div>
          </div>
        </div>
      )}

      {/* ── Bundle trigger groups ── */}
      {isBundle && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>Bundle items</div>
            <button type="button" onClick={addGroup} style={{
              ...S.btn, padding:'4px 12px', fontSize:11, background:'var(--acc)', color:'#0e0f14',
            }}>+ Add category group</button>
          </div>
          <div style={{ fontSize:11, color:'var(--t3)', marginBottom:12 }}>
            Customer must buy the specified quantity from each category group to qualify
          </div>
          {form.triggerGroups.map((group, idx) => (
            <div key={idx} style={{
              display:'flex', alignItems:'flex-start', gap:10, padding:10, marginBottom:6,
              background:'var(--bg2)', borderRadius:8, border:'1px solid var(--bdr)',
            }}>
              <div style={{ width:60, flexShrink:0 }}>
                <label style={{ ...S.label, fontSize:10 }}>Qty</label>
                <input style={{ ...S.input, textAlign:'center' }} type="number" min="1" value={group.qty}
                  onChange={e => updateGroup(idx, { qty: parseInt(e.target.value) || 1 })} />
              </div>
              <div style={{ flex:1 }}>
                <label style={{ ...S.label, fontSize:10 }}>From categories</label>
                <CategoryPicker selected={group.categoryIds} onChange={v => updateGroup(idx, { categoryIds: v })} categories={categories} />
              </div>
              {form.triggerGroups.length > 1 && (
                <button type="button" onClick={() => removeGroup(idx)} style={{
                  ...S.btn, padding:'6px 8px', background:'none', color:'var(--red)', fontSize:16, marginTop:18,
                }}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reward section — different for buy_x vs bundle */}
      {!isBundle && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:10 }}>Reward</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:14, marginBottom:14 }}>
            <div>
              <label style={S.label}>Reward quantity</label>
              <input style={S.input} type="number" min="1" value={form.rewardQty}
                onChange={e => f('rewardQty', e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Discount type</label>
              <select style={S.select} value={form.rewardType} onChange={e => f('rewardType', e.target.value)}>
                <option value="percent">% off</option>
                <option value="amount">£ off</option>
                <option value="free">Free (100% off)</option>
              </select>
            </div>
            {form.rewardType !== 'free' && (
              <div>
                <label style={S.label}>{form.rewardType === 'percent' ? 'Percentage' : 'Amount'}</label>
                <input style={S.input} type="number" min="0" value={form.rewardValue}
                  onChange={e => f('rewardValue', e.target.value)}
                  placeholder={form.rewardType === 'percent' ? '50' : '5.00'} />
              </div>
            )}
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom: sameRewardCats ? 0 : 10 }}>
            <Toggle value={sameRewardCats} onChange={setSameRewardCats} />
            <span style={{ fontSize:12, color:'var(--t2)' }}>Reward applies to same categories as trigger</span>
          </div>

          {!sameRewardCats && (
            <div>
              <label style={S.label}>Reward categories</label>
              <CategoryPicker selected={form.rewardCategoryIds} onChange={v => f('rewardCategoryIds', v)} categories={categories} />
            </div>
          )}
        </div>
      )}

      {/* Bundle fixed price */}
      {isBundle && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:10 }}>Bundle price</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginBottom:10 }}>
            Set the total price customers pay for the bundle. The difference from individual item prices is the discount.
          </div>
          <div style={{ maxWidth:200 }}>
            <label style={S.label}>Fixed price (£)</label>
            <input style={S.input} type="number" min="0" step="0.01" value={form.rewardValue}
              onChange={e => f('rewardValue', e.target.value)} placeholder="e.g. 15.00" />
          </div>
        </div>
      )}

      {/* When it applies — days, time window, start + expiry */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:14 }}>
        <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>When it applies</div>
        <div style={{ fontSize:11, color:'var(--t3)', marginBottom:12 }}>Leave everything blank to run all day, every day, with no end date.</div>

        <label style={S.label}>Days</label>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
          {DOW.map(([d, label]) => (
            <button key={d} type="button" onClick={() => toggleDay(d)} style={{
              padding:'6px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:600,
              border:`1.5px solid ${sched.days.includes(d) ? 'var(--acc)' : 'var(--bdr)'}`,
              background: sched.days.includes(d) ? 'var(--acc-d)' : 'var(--bg3)',
              color: sched.days.includes(d) ? 'var(--acc)' : 'var(--t3)',
            }}>{label}</button>
          ))}
          {sched.days.length > 0 && (
            <button type="button" onClick={() => setSched({ days: [] })} style={{ padding:'6px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:600, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t3)' }}>Every day</button>
          )}
        </div>

        <label style={S.label}>Time of day (optional)</label>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:14 }}>
          <input type="time" style={{ ...S.input, width:130 }} value={win.start} onChange={e => setWindow({ start: e.target.value })} />
          <span style={{ color:'var(--t3)', fontSize:12 }}>to</span>
          <input type="time" style={{ ...S.input, width:130 }} value={win.end} onChange={e => setWindow({ end: e.target.value })} />
          {(win.start || win.end) && (
            <button type="button" onClick={() => setSched({ windows: [] })} style={{ padding:'6px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:11, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t3)' }}>Clear</button>
          )}
        </div>

        <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
          <div>
            <label style={S.label}>Starts (optional)</label>
            <input type="date" style={{ ...S.input, width:170 }} value={sched.startsAt} onChange={e => setSched({ startsAt: e.target.value })} />
          </div>
          <div>
            <label style={S.label}>Expires (optional)</label>
            <input type="date" style={{ ...S.input, width:170 }} value={sched.expiresAt} onChange={e => setSched({ expiresAt: e.target.value })} />
          </div>
        </div>
        {sched.expiresAt && <div style={{ fontSize:11, color:'var(--t3)', marginTop:6 }}>Stops applying after {sched.expiresAt} (inclusive, venue time).</div>}
      </div>

      {/* Channel targeting */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:14, marginBottom:14 }}>
        <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:10 }}>Active on channels</div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {Object.entries(CHANNEL_LABELS).map(([key, label]) => (
            <button key={key} type="button" onClick={() => toggleChannel(key)} style={{
              padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:600,
              border:`1.5px solid ${form.channels[key] ? 'var(--acc)' : 'var(--bdr)'}`,
              background: form.channels[key] ? 'var(--acc-d)' : 'var(--bg3)',
              color: form.channels[key] ? 'var(--acc)' : 'var(--t3)',
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)' }} onClick={onCancel}>Cancel</button>
        <button style={{ ...S.btn, background:'var(--acc)', color:'#0e0f14' }} onClick={handleSave}
          disabled={saving || !form.name.trim()}>
          {saving ? 'Saving...' : 'Save rule'}
        </button>
      </div>
    </div>
  );
}

/* ── Main DiscountManager ─────────────────────────────────────────────────── */

export default function DiscountManager() {
  const { menuCategories } = useStore();
  const showToast = useStore(s => s.showToast);
  const [tab, setTab] = useState('presets'); // 'presets' | 'rules'
  const [discounts, setDiscounts] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingDiscount, setEditingDiscount] = useState(null); // null | {} for new | existing obj
  const [editingRule, setEditingRule] = useState(null);

  // Flat category list for pickers
  const categories = (menuCategories || []).map(c => ({
    id: c.id, label: c.label || c.name || 'Category', icon: c.icon || '🍽',
  }));

  // ── Load data ──
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const locationId = await getLocationId();
        if (!locationId || locationId === 'loc-demo' || isMock) { setLoading(false); return; }
        const [discRes, rulesRes] = await Promise.all([
          supabase.from('discounts').select('*').eq('location_id', locationId).order('sort_order'),
          supabase.from('discount_rules').select('*').eq('location_id', locationId).order('priority', { ascending: false }),
        ]);
        // Say so rather than showing an empty list — an operator who believes the list is
        // empty re-creates everything and ends up with duplicates.
        if (discRes.error || rulesRes.error) {
          console.error('[DiscountManager] load error:', discRes.error?.message || rulesRes.error?.message);
          showToast?.('Discounts could not be loaded — this list may be incomplete. Reload before editing.', 'error');
        }
        setDiscounts((discRes.data || []).map(d => ({
          id: d.id, name: d.name, type: d.type, value: parseFloat(d.value),
          scope: d.scope, categoryIds: d.category_ids || [],
          requiresManager: d.requires_manager, active: d.active,
          sortOrder: d.sort_order ?? 0,
        })));
        setRules((rulesRes.data || []).map(r => ({
          id: r.id, name: r.name, active: r.active,
          triggerType: r.trigger_type, triggerCategoryIds: r.trigger_category_ids || [],
          triggerQty: r.trigger_qty, rewardType: r.reward_type,
          rewardValue: parseFloat(r.reward_value), rewardQty: r.reward_qty,
          rewardCategoryIds: r.reward_category_ids || [],
          channels: r.channels || { pos:true, online:true, qr:true, kiosk:true },
          triggerGroups: r.trigger_groups || null,
          schedule: r.schedule || null,
          priority: r.priority ?? 0, sortOrder: r.sort_order ?? 0,
        })));
      } catch (e) { console.error('[DiscountManager] load error:', e); }
      setLoading(false);
    })();
  }, []);

  // ── Sync presets + rules to Zustand store after save ──
  const syncToStore = (newDiscounts, newRules) => {
    useStore.setState({
      discountPresets: (newDiscounts || discounts).filter(d => d.active).map(d => ({
        ...d, label: d.name,
      })),
      discountRules: (newRules || rules).filter(r => r.active),
    });
  };

  // A delete that RLS filters out resolves with no error and no rows, which is exactly what a
  // successful delete looks like from here (db.js doesn't .select()). Probe the row instead.
  const stillThere = async (table, id) => {
    if (isMock || !supabase) return false;
    const { data } = await supabase.from(table).select('id').eq('id', id).maybeSingle();
    return !!data;
  };

  // ── Save discount ──
  const saveDiscount = async (form) => {
    const locationId = await getLocationId().catch(() => null);
    if (!locationId || locationId === 'loc-demo') {
      reportSave('discount', new Error('Could not resolve the location for this venue'));
      showToast?.(`"${form.name}" was NOT saved — could not resolve this location`, 'error');
      return;
    }
    const { error } = await upsertDiscount(form, locationId);
    reportSave('discount', error);
    if (error) {
      // Nothing local changed yet, so there is nothing to roll back — just don't pretend.
      showToast?.(`"${form.name}" was NOT saved — the database rejected it`, 'error');
      return;
    }
    // Re-fetch
    const { data, error: readErr } = await supabase.from('discounts').select('*').eq('location_id', locationId).order('sort_order');
    if (readErr) {
      // The write landed; only the read-back failed. Don't publish a half-list to the POS.
      console.error('[DiscountManager] reload after save failed:', readErr.message);
      setEditingDiscount(null);
      showToast?.(`"${form.name}" saved, but the list could not be refreshed — reload the page`, 'warning');
      return;
    }
    const mapped = (data || []).map(d => ({
      id: d.id, name: d.name, type: d.type, value: parseFloat(d.value),
      scope: d.scope, categoryIds: d.category_ids || [],
      requiresManager: d.requires_manager, active: d.active, sortOrder: d.sort_order ?? 0,
    }));
    setDiscounts(mapped);
    syncToStore(mapped, null);
    setEditingDiscount(null);
    showToast?.(`"${form.name}" saved`, 'success');
  };

  // ── Delete discount ──
  const removeDiscount = async (id) => {
    const disc = discounts.find(d => d.id === id);
    const { error } = await deleteDiscount(id);
    let failure = error;
    if (!failure && await stillThere('discounts', id)) failure = new Error('Discount delete matched 0 rows — RLS blocked it');
    reportSave('discount delete', failure);
    if (failure) {
      // Store untouched — the POS keeps offering a discount that still exists.
      showToast?.(`"${disc?.name || 'Discount'}" was NOT deleted`, 'error');
      return;
    }
    const next = discounts.filter(d => d.id !== id);
    setDiscounts(next);
    syncToStore(next, null);
    showToast?.(`"${disc?.name || 'Discount'}" deleted`, 'info');
  };

  // ── Toggle discount active ──
  const toggleDiscount = async (disc) => {
    await saveDiscount({ ...disc, active: !disc.active });
  };

  // ── Save rule ──
  const saveRule = async (form) => {
    const locationId = await getLocationId().catch(() => null);
    if (!locationId || locationId === 'loc-demo') {
      reportSave('auto-discount rule', new Error('Could not resolve the location for this venue'));
      showToast?.(`"${form.name}" was NOT saved — could not resolve this location`, 'error');
      return;
    }
    const { error } = await upsertDiscountRule(form, locationId);
    reportSave('auto-discount rule', error);
    if (error) {
      showToast?.(`"${form.name}" was NOT saved — the database rejected it`, 'error');
      return;
    }
    // Re-fetch
    const { data, error: readErr } = await supabase.from('discount_rules').select('*').eq('location_id', locationId).order('priority', { ascending: false });
    if (readErr) {
      console.error('[DiscountManager] reload after save failed:', readErr.message);
      setEditingRule(null);
      showToast?.(`"${form.name}" saved, but the list could not be refreshed — reload the page`, 'warning');
      return;
    }
    const mapped = (data || []).map(r => ({
      id: r.id, name: r.name, active: r.active,
      triggerType: r.trigger_type, triggerCategoryIds: r.trigger_category_ids || [],
      triggerQty: r.trigger_qty, rewardType: r.reward_type,
      rewardValue: parseFloat(r.reward_value), rewardQty: r.reward_qty,
      rewardCategoryIds: r.reward_category_ids || [],
      channels: r.channels || { pos:true, online:true, qr:true, kiosk:true },
      triggerGroups: r.trigger_groups || null,
      schedule: r.schedule || null,
      priority: r.priority ?? 0, sortOrder: r.sort_order ?? 0,
    }));
    setRules(mapped);
    syncToStore(null, mapped);
    setEditingRule(null);
    showToast?.(`"${form.name}" saved`, 'success');
  };

  // ── Delete rule ──
  const removeRule = async (id) => {
    const rule = rules.find(r => r.id === id);
    const { error } = await deleteDiscountRule(id);
    let failure = error;
    if (!failure && await stillThere('discount_rules', id)) failure = new Error('Rule delete matched 0 rows — RLS blocked it');
    reportSave('auto-discount rule delete', failure);
    if (failure) {
      showToast?.(`"${rule?.name || 'Rule'}" was NOT deleted — it is still live`, 'error');
      return;
    }
    const next = rules.filter(r => r.id !== id);
    setRules(next);
    syncToStore(null, next);
    showToast?.(`"${rule?.name || 'Rule'}" deleted`, 'info');
  };

  // ── Toggle rule active ──
  const toggleRule = async (rule) => {
    await saveRule({ ...rule, active: !rule.active });
  };

  if (loading) return <div style={S.page}><div style={S.h1}>Discounts</div><div style={{ color:'var(--t3)', marginTop:20 }}>Loading...</div></div>;

  return (
    <div style={S.page}>
      <div style={S.h1}>Discounts</div>
      <div style={S.sub}>Create and manage discount presets for staff and automatic discount rules for customers</div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, background:'var(--bg2)', borderRadius:10, padding:3 }}>
        {[['presets','Discount presets'],['rules','Auto-discount rules']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flex:1, padding:'10px 16px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
            fontSize:13, fontWeight:600, border:'none',
            background: tab === id ? 'var(--bg1)' : 'transparent',
            color: tab === id ? 'var(--t1)' : 'var(--t3)',
            boxShadow: tab === id ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
          }}>
            {label}
            <span style={{ marginLeft:6, fontSize:11, opacity:.6 }}>
              ({id === 'presets' ? discounts.length : rules.length})
            </span>
          </button>
        ))}
      </div>

      {/* ── Presets tab ── */}
      {tab === 'presets' && (
        <>
          {!editingDiscount && (
            <button onClick={() => setEditingDiscount({})} style={{
              ...S.btn, background:'var(--acc)', color:'#0e0f14', marginBottom:16,
              display:'flex', alignItems:'center', gap:6,
            }}>
              + Add discount
            </button>
          )}

          {editingDiscount && !editingDiscount.id && (
            <DiscountForm discount={editingDiscount} categories={categories}
              onSave={saveDiscount} onCancel={() => setEditingDiscount(null)} />
          )}

          {discounts.length === 0 && !editingDiscount && (
            <div style={{ ...S.card, textAlign:'center', padding:40 }}>
              <div style={{ fontSize:32, marginBottom:8 }}>🏷</div>
              <div style={{ fontSize:14, fontWeight:600, color:'var(--t2)', marginBottom:4 }}>No discounts yet</div>
              <div style={{ fontSize:12, color:'var(--t3)' }}>Add custom discounts your staff can apply at the POS</div>
            </div>
          )}

          {discounts.map(disc => (
            editingDiscount?.id === disc.id ? (
              <DiscountForm key={disc.id} discount={disc} categories={categories}
                onSave={saveDiscount} onCancel={() => setEditingDiscount(null)} />
            ) : (
              <div key={disc.id} style={{ ...S.card, display:'flex', alignItems:'center', gap:14, opacity: disc.active ? 1 : 0.5 }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{disc.name}</span>
                    <span style={{
                      ...S.badge,
                      background: disc.type === 'percent' ? 'var(--acc-d)' : 'var(--grn-d)',
                      color: disc.type === 'percent' ? 'var(--acc)' : 'var(--grn)',
                      border: `1px solid ${disc.type === 'percent' ? 'var(--acc-b)' : 'var(--grn-b)'}`,
                    }}>
                      {disc.type === 'percent' ? `${disc.value}%` : `${money(disc.value)}`}
                    </span>
                    <span style={{ ...S.badge, background:'var(--bg3)', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
                      {disc.scope === 'global' ? 'All items' : `${disc.categoryIds.length} categories`}
                    </span>
                    {disc.requiresManager && (
                      <span style={{ ...S.badge, background:'rgba(232,160,32,.1)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>
                        🔑 Manager
                      </span>
                    )}
                  </div>
                  {disc.scope === 'category' && disc.categoryIds.length > 0 && (
                    <div style={{ fontSize:11, color:'var(--t3)' }}>
                      {categories.filter(c => disc.categoryIds.includes(c.id)).map(c => c.label).join(', ')}
                    </div>
                  )}
                </div>
                <Toggle value={disc.active} onChange={() => toggleDiscount(disc)} />
                <button onClick={() => setEditingDiscount(disc)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', padding:'6px 12px' }}>Edit</button>
                <button onClick={() => removeDiscount(disc.id)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--red)', padding:'6px 12px' }}>Delete</button>
              </div>
            )
          ))}
        </>
      )}

      {/* ── Rules tab ── */}
      {tab === 'rules' && (
        <>
          {!editingRule && (
            <button onClick={() => setEditingRule({})} style={{
              ...S.btn, background:'var(--acc)', color:'#0e0f14', marginBottom:16,
              display:'flex', alignItems:'center', gap:6,
            }}>
              + Add auto-discount rule
            </button>
          )}

          {editingRule && !editingRule.id && (
            <RuleForm rule={editingRule} categories={categories}
              onSave={saveRule} onCancel={() => setEditingRule(null)} />
          )}

          {rules.length === 0 && !editingRule && (
            <div style={{ ...S.card, textAlign:'center', padding:40 }}>
              <div style={{ fontSize:32, marginBottom:8 }}>🤖</div>
              <div style={{ fontSize:14, fontWeight:600, color:'var(--t2)', marginBottom:4 }}>No auto-discount rules</div>
              <div style={{ fontSize:12, color:'var(--t3)' }}>Create rules like "Buy 2 pizzas, get 3rd 50% off" that apply automatically</div>
            </div>
          )}

          {rules.map(rule => (
            editingRule?.id === rule.id ? (
              <RuleForm key={rule.id} rule={rule} categories={categories}
                onSave={saveRule} onCancel={() => setEditingRule(null)} />
            ) : (
              <div key={rule.id} style={{ ...S.card, opacity: rule.active ? 1 : 0.5 }}>
                <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                      <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{rule.name}</span>
                    </div>
                    <div style={{ fontSize:12, color:'var(--t2)', marginBottom:6 }}>
                      {rule.triggerType === 'bundle' ? (
                        <>
                          {(rule.triggerGroups || []).map((g, i) => {
                            const names = categories.filter(c => (g.categoryIds || g.category_ids || []).includes(c.id)).map(c => c.label).join(', ') || 'any';
                            return <span key={i}>{i > 0 && ' + '}<strong>{g.qty ?? 1} × {names}</strong></span>;
                          })}
                          {' = '}<strong>{money(Number(rule.rewardValue || 0))}</strong>
                        </>
                      ) : (
                        <>
                          Buy {rule.triggerQty} from{' '}
                          <strong>{categories.filter(c => rule.triggerCategoryIds.includes(c.id)).map(c => c.label).join(', ') || 'any'}</strong>
                          {' → '}get {rule.rewardQty}{' '}
                          {rule.rewardType === 'free' ? 'free' : rule.rewardType === 'percent' ? `${rule.rewardValue}% off` : `${currencySymbol()}${rule.rewardValue} off`}
                        </>
                      )}
                    </div>
                    {scheduleSummary(rule.schedule) && (
                      <div style={{ fontSize:11, color:'var(--t3)', marginBottom:6, display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                        <span style={{ fontSize:9, fontWeight:800, color:'var(--acc)', border:'1px solid var(--acc-b)', background:'var(--acc-d)', borderRadius:4, padding:'1px 5px' }}>⏰ SCHEDULED</span>
                        <span>{scheduleSummary(rule.schedule)}</span>
                      </div>
                    )}
                    <div style={{ display:'flex', gap:4 }}>
                      {Object.entries(CHANNEL_LABELS).map(([key, label]) => (
                        <span key={key} style={{
                          ...S.badge, fontSize:10,
                          background: rule.channels?.[key] ? 'var(--grn-d)' : 'var(--bg3)',
                          color: rule.channels?.[key] ? 'var(--grn)' : 'var(--t4)',
                          border: `1px solid ${rule.channels?.[key] ? 'var(--grn-b)' : 'var(--bdr)'}`,
                        }}>
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Toggle value={rule.active} onChange={() => toggleRule(rule)} />
                  <button onClick={() => setEditingRule(rule)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', padding:'6px 12px' }}>Edit</button>
                  <button onClick={() => removeRule(rule.id)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--red)', padding:'6px 12px' }}>Delete</button>
                </div>
              </div>
            )
          ))}
        </>
      )}
    </div>
  );
}
