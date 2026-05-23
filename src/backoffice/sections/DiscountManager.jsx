import { useState, useEffect } from 'react';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { useStore } from '../../store';

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
  rewardType:'percent', rewardValue:'', rewardQty:1, rewardCategoryIds:[],
  channels:{ pos:true, online:true, qr:true, kiosk:true },
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
  });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);
  const [sameRewardCats, setSameRewardCats] = useState(
    !rule?.rewardCategoryIds?.length || JSON.stringify(rule?.rewardCategoryIds) === JSON.stringify(rule?.triggerCategoryIds)
  );

  const toggleChannel = (ch) => {
    f('channels', { ...form.channels, [ch]: !form.channels[ch] });
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const payload = {
      ...form,
      rewardValue: parseFloat(form.rewardValue) || 0,
      triggerQty: parseInt(form.triggerQty) || 2,
      rewardQty: parseInt(form.rewardQty) || 1,
      rewardCategoryIds: sameRewardCats ? [] : form.rewardCategoryIds,
    };
    await onSave(payload);
    setSaving(false);
  };

  // Build human-readable summary
  const triggerCatNames = categories.filter(c => form.triggerCategoryIds.includes(c.id)).map(c => c.label).join(', ') || 'any category';
  const rewardLabel = form.rewardType === 'free' ? 'free'
    : form.rewardType === 'percent' ? `${form.rewardValue || '?'}% off`
    : `£${form.rewardValue || '?'} off`;
  const summary = `Buy ${form.triggerQty} from ${triggerCatNames}, get ${form.rewardQty} ${rewardLabel}`;

  return (
    <div style={{ ...S.card, border:'1.5px solid var(--acc-b)', background:'var(--acc-d)' }}>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>
        {rule?.id ? 'Edit auto-discount rule' : 'Add auto-discount rule'}
      </div>
      <div style={{ fontSize:11, color:'var(--t3)', marginBottom:16, fontStyle:'italic' }}>{summary}</div>

      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Rule name</label>
        <input style={S.input} value={form.name} onChange={e => f('name', e.target.value)}
          placeholder="e.g. Buy 2 pizzas get 3rd 50% off" />
      </div>

      {/* Trigger section */}
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

      {/* Reward section */}
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

  // ── Save discount ──
  const saveDiscount = async (form) => {
    try {
      const locationId = await getLocationId();
      const { upsertDiscount } = await import('../../lib/db.js');
      await upsertDiscount(form, locationId);
      // Re-fetch
      const { data } = await supabase.from('discounts').select('*').eq('location_id', locationId).order('sort_order');
      const mapped = (data || []).map(d => ({
        id: d.id, name: d.name, type: d.type, value: parseFloat(d.value),
        scope: d.scope, categoryIds: d.category_ids || [],
        requiresManager: d.requires_manager, active: d.active, sortOrder: d.sort_order ?? 0,
      }));
      setDiscounts(mapped);
      syncToStore(mapped, null);
      setEditingDiscount(null);
    } catch (e) { console.error('[DiscountManager] save discount error:', e); }
  };

  // ── Delete discount ──
  const removeDiscount = async (id) => {
    try {
      const { deleteDiscount } = await import('../../lib/db.js');
      await deleteDiscount(id);
      const next = discounts.filter(d => d.id !== id);
      setDiscounts(next);
      syncToStore(next, null);
    } catch (e) { console.error('[DiscountManager] delete error:', e); }
  };

  // ── Toggle discount active ──
  const toggleDiscount = async (disc) => {
    await saveDiscount({ ...disc, active: !disc.active });
  };

  // ── Save rule ──
  const saveRule = async (form) => {
    try {
      const locationId = await getLocationId();
      const { upsertDiscountRule } = await import('../../lib/db.js');
      await upsertDiscountRule(form, locationId);
      // Re-fetch
      const { data } = await supabase.from('discount_rules').select('*').eq('location_id', locationId).order('priority', { ascending: false });
      const mapped = (data || []).map(r => ({
        id: r.id, name: r.name, active: r.active,
        triggerType: r.trigger_type, triggerCategoryIds: r.trigger_category_ids || [],
        triggerQty: r.trigger_qty, rewardType: r.reward_type,
        rewardValue: parseFloat(r.reward_value), rewardQty: r.reward_qty,
        rewardCategoryIds: r.reward_category_ids || [],
        channels: r.channels || { pos:true, online:true, qr:true, kiosk:true },
        priority: r.priority ?? 0, sortOrder: r.sort_order ?? 0,
      }));
      setRules(mapped);
      syncToStore(null, mapped);
      setEditingRule(null);
    } catch (e) { console.error('[DiscountManager] save rule error:', e); }
  };

  // ── Delete rule ──
  const removeRule = async (id) => {
    try {
      const { deleteDiscountRule } = await import('../../lib/db.js');
      await deleteDiscountRule(id);
      const next = rules.filter(r => r.id !== id);
      setRules(next);
      syncToStore(null, next);
    } catch (e) { console.error('[DiscountManager] delete rule error:', e); }
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
                      {disc.type === 'percent' ? `${disc.value}%` : `£${disc.value.toFixed(2)}`}
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
                      Buy {rule.triggerQty} from{' '}
                      <strong>{categories.filter(c => rule.triggerCategoryIds.includes(c.id)).map(c => c.label).join(', ') || 'any'}</strong>
                      {' → '}get {rule.rewardQty}{' '}
                      {rule.rewardType === 'free' ? 'free' : rule.rewardType === 'percent' ? `${rule.rewardValue}% off` : `£${rule.rewardValue} off`}
                    </div>
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
