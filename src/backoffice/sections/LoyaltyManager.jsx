// src/backoffice/sections/LoyaltyManager.jsx
// v5.5.218 — Back office loyalty management.
// Configuration, rewards catalog CRUD, member lookup, tier management.
// Follows the same pattern as GiftCards.jsx:
//   - callLoyalty() helper auto-injects location_id
//   - platformSupabase for location/company resolution
//   - Tab-based sub-sections

import { useState, useEffect, useCallback } from 'react';
import { supabase, platformSupabase, getLocationId, getActiveLocationSync } from '../../lib/supabase';
import { customerUrl } from '../../lib/env';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  page:    { padding: '32px 40px', maxWidth: 1080 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 28, maxWidth: 720, lineHeight: 1.5 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  label:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input:   { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn:     { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnDan:  { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  successBox:{ padding: 12, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--grn-b, var(--grn))' },
};

// ── Helper: call loyalty edge function ────────────────────────────────
// Auto-injects location_id for company resolution (same pattern as callGift).
async function callLoyalty(endpoint, bodyOrNull, method = 'POST') {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const locationId = getActiveLocationSync() || await getLocationId();
  if (method === 'GET') {
    const params = new URLSearchParams(bodyOrNull || {});
    if (!params.has('location_id') && locationId) params.set('location_id', locationId);
    const res = await fetch(`${FUNCTIONS_URL}/${endpoint}?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j;
  }
  const body = { ...bodyOrNull, location_id: bodyOrNull?.location_id || locationId };
  const res = await fetch(`${FUNCTIONS_URL}/${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// ── PATCH helper (loyalty-rewards uses PATCH) ─────────────────────────
async function callLoyaltyPatch(endpoint, body) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const locationId = getActiveLocationSync() || await getLocationId();
  const res = await fetch(`${FUNCTIONS_URL}/${endpoint}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, location_id: body?.location_id || locationId }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// ── DELETE helper ─────────────────────────────────────────────────────
async function callLoyaltyDelete(endpoint, body) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const locationId = getActiveLocationSync() || await getLocationId();
  const res = await fetch(`${FUNCTIONS_URL}/${endpoint}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, location_id: body?.location_id || locationId }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// ── Reward type labels ────────────────────────────────────────────────
const REWARD_TYPES = [
  { value: 'discount_fixed', label: 'Fixed discount (e.g. £1 off)' },
  { value: 'discount_percent', label: 'Percentage discount (e.g. 10% off)' },
  { value: 'free_item', label: 'Free item' },
  { value: 'free_delivery', label: 'Free delivery' },
  { value: 'custom', label: 'Custom reward' },
];

const REWARD_ICONS = ['gift', 'star', 'coffee', 'pizza', 'beer', 'cake', 'heart', 'fire', 'sparkles', 'crown', 'ticket', 'percent'];

// ═══════════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════════
export default function LoyaltyManager() {
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [rewards, setRewards] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState('');
  const [slug, setSlug] = useState(null);

  // Load config on mount
  const loadConfig = useCallback(async () => {
    try {
      const data = await callLoyalty('loyalty-config', {}, 'GET');
      setConfig(data.config || null);
      setRewards(data.rewards || []);
      setTiers(data.tiers || []);
    } catch (e) {
      console.error('[LoyaltyManager] load:', e);
    } finally {
      setLoading(false);
    }
    // Resolve slug for customer portal link
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (locId && platformSupabase) {
        const { data: loc } = await platformSupabase
          .from('locations')
          .select('online_slug')
          .eq('ops_location_id', locId)
          .maybeSingle();
        if (loc?.online_slug) setSlug(loc.online_slug);
      }
    } catch {}
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Toggle enabled
  const toggleEnabled = async () => {
    if (!config) return;
    setEnabling(true);
    setEnableError('');
    try {
      const res = await callLoyalty('loyalty-config', { enabled: !config.enabled });
      setConfig(res.config);
    } catch (e) {
      setEnableError(e?.message || 'Failed to toggle');
    } finally {
      setEnabling(false);
    }
  };

  const loyaltyEnabled = !!config?.enabled;

  if (loading) return <div style={{ padding: 40, color: 'var(--t4)', fontSize: 13 }}>Loading...</div>;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>{'⭐'} Loyalty Program</h1>
      <div style={S.sub}>
        Reward your customers for every purchase. Configure points, create rewards, and manage your loyalty program.
      </div>

      {/* ── Status card ──────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 2 }}>
              Loyalty program
            </div>
            <div style={{ fontSize: 12, color: 'var(--t4)' }}>
              {loyaltyEnabled
                ? 'Active — customers earn points on every purchase'
                : 'Disabled — toggle on to start rewarding your customers'}
            </div>
          </div>
          <button
            onClick={toggleEnabled}
            disabled={enabling}
            style={{
              width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer',
              background: loyaltyEnabled ? 'var(--grn)' : 'var(--bdr2)',
              position: 'relative', transition: 'background .2s', flexShrink: 0,
            }}
          >
            <div style={{
              width: 20, height: 20, borderRadius: 10, background: '#fff',
              position: 'absolute', top: 3,
              left: loyaltyEnabled ? 25 : 3,
              transition: 'left .2s',
            }}/>
          </button>
        </div>

        {enableError && <div style={S.errorBox}>{enableError}</div>}

        {/* Customer portal link */}
        {slug && (
          <PortalLink slug={slug} enabled={loyaltyEnabled} />
        )}

        {/* Config summary stats */}
        {config && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 6, fontSize: 12 }}>
            <ConfigStat label="Points per £1" value={config.points_per_currency_unit ?? 1} />
            <ConfigStat label="Point value" value={config.points_currency_value ? `${config.points_currency_value}p` : '1p'} />
            <ConfigStat label="Rounding" value={(config.points_rounding || 'floor').charAt(0).toUpperCase() + (config.points_rounding || 'floor').slice(1)} />
            <ConfigStat label="Rewards" value={rewards.filter(r => r.active).length} />
          </div>
        )}
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--bdr)', paddingBottom: 0, flexWrap: 'wrap' }}>
        {[
          { id: 'rewards', label: 'Rewards' },
          { id: 'settings', label: 'Points settings' },
          { id: 'members', label: 'Members' },
          { id: 'tiers', label: 'Tiers' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...S.btn,
              background: tab === t.id ? 'var(--acc)' : 'transparent',
              color: tab === t.id ? '#0b0c10' : 'var(--t3)',
              borderRadius: '8px 8px 0 0',
              padding: '8px 14px',
              borderBottom: tab === t.id ? '2px solid var(--acc)' : '2px solid transparent',
              marginBottom: -2, fontSize: 12,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'rewards' && <RewardsPanel rewards={rewards} onReload={loadConfig} />}
      {tab === 'settings' && <SettingsPanel config={config} onUpdate={setConfig} />}
      {tab === 'members' && <MembersPanel config={config} />}
      {tab === 'tiers' && <TiersPanel tiers={tiers} onReload={loadConfig} />}
    </div>
  );
}

// ── Config stat cell ──────────────────────────────────────────────────
function ConfigStat({ label, value }) {
  return (
    <div style={{ padding: '8px 10px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 12 }}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Rewards Panel — CRUD for the reward catalog
// ═══════════════════════════════════════════════════════════════════════
function RewardsPanel({ rewards, onReload }) {
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // New reward form state
  const blank = { name: '', description: '', icon: 'gift', points_cost: '', reward_type: 'discount_fixed', reward_value: {}, sort_order: 0 };
  const [form, setForm] = useState(blank);

  const startEdit = (r) => {
    setEditId(r.id);
    setForm({
      name: r.name,
      description: r.description || '',
      icon: r.icon || 'gift',
      points_cost: r.points_cost,
      reward_type: r.reward_type,
      reward_value: r.reward_value || {},
      sort_order: r.sort_order || 0,
    });
    setCreating(false);
  };

  const startCreate = () => {
    setCreating(true);
    setEditId(null);
    setForm(blank);
  };

  const cancel = () => {
    setCreating(false);
    setEditId(null);
    setForm(blank);
    setError('');
  };

  const save = async () => {
    if (!form.name || !form.points_cost || !form.reward_type) {
      setError('Name, points cost, and reward type are required');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (editId) {
        await callLoyaltyPatch('loyalty-rewards', { id: editId, ...form, points_cost: Number(form.points_cost) });
        setSuccess('Reward updated');
      } else {
        await callLoyalty('loyalty-rewards', { ...form, points_cost: Number(form.points_cost) });
        setSuccess('Reward created');
      }
      cancel();
      onReload();
    } catch (e) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (id) => {
    try {
      await callLoyaltyDelete('loyalty-rewards', { id });
      setSuccess('Reward deactivated');
      onReload();
    } catch (e) {
      setError(e?.message || 'Failed to deactivate');
    }
  };

  const activeRewards = rewards.filter(r => r.active);
  const inactiveRewards = rewards.filter(r => !r.active);

  return (
    <div>
      {error && <div style={S.errorBox}>{error}</div>}
      {success && <div style={S.successBox}>{success}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Rewards catalog</div>
        {!creating && !editId && (
          <button onClick={startCreate} style={{ ...S.btn, ...S.btnPrim }}>+ Add reward</button>
        )}
      </div>

      {/* Create / Edit form */}
      {(creating || editId) && (
        <div style={{ ...S.card, border: '2px solid var(--acc)', marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>
            {editId ? 'Edit reward' : 'New reward'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={S.label}>Name</label>
              <input style={S.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. £1 off your next order" />
            </div>
            <div>
              <label style={S.label}>Points cost</label>
              <input style={S.input} type="number" min="1" value={form.points_cost} onChange={e => setForm(f => ({ ...f, points_cost: e.target.value }))} placeholder="e.g. 100" />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>Description</label>
            <input style={S.input} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Shown to customers when browsing rewards" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={S.label}>Reward type</label>
              <select
                style={S.input}
                value={form.reward_type}
                onChange={e => setForm(f => ({ ...f, reward_type: e.target.value, reward_value: {} }))}
              >
                {REWARD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Icon</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {REWARD_ICONS.map(ic => (
                  <button
                    key={ic}
                    onClick={() => setForm(f => ({ ...f, icon: ic }))}
                    style={{
                      ...S.btn, padding: '4px 8px', fontSize: 11,
                      background: form.icon === ic ? 'var(--acc)' : 'var(--bg2)',
                      color: form.icon === ic ? '#0b0c10' : 'var(--t3)',
                      border: `1px solid ${form.icon === ic ? 'var(--acc)' : 'var(--bdr)'}`,
                    }}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Reward value fields — context-dependent */}
          {form.reward_type === 'discount_fixed' && (
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>Discount amount (pence)</label>
              <input
                style={S.input} type="number" min="1"
                value={form.reward_value.amount_minor || ''}
                onChange={e => setForm(f => ({ ...f, reward_value: { ...f.reward_value, amount_minor: Number(e.target.value) } }))}
                placeholder="e.g. 100 for £1.00 off"
              />
            </div>
          )}
          {form.reward_type === 'discount_percent' && (
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>Discount percentage</label>
              <input
                style={S.input} type="number" min="1" max="100"
                value={form.reward_value.percent || ''}
                onChange={e => setForm(f => ({ ...f, reward_value: { ...f.reward_value, percent: Number(e.target.value) } }))}
                placeholder="e.g. 10 for 10% off"
              />
            </div>
          )}
          {form.reward_type === 'free_item' && (
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>Item description (shown to staff)</label>
              <input
                style={S.input}
                value={form.reward_value.item_description || ''}
                onChange={e => setForm(f => ({ ...f, reward_value: { ...f.reward_value, item_description: e.target.value } }))}
                placeholder="e.g. Any hot drink up to £4"
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrim }}>
              {saving ? 'Saving...' : editId ? 'Update' : 'Create reward'}
            </button>
            <button onClick={cancel} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Active rewards list */}
      {activeRewards.length === 0 && !creating && (
        <div style={{ ...S.card, textAlign: 'center', padding: 28, color: 'var(--t4)', fontSize: 13 }}>
          No rewards created yet. Add your first reward to give customers something to redeem their points for.
        </div>
      )}

      {activeRewards.map(r => (
        <div key={r.id} style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: 'var(--acc-d, var(--bg2))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0, border: '1px solid var(--bdr)',
          }}>
            {r.icon || 'gift'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{r.name}</div>
            {r.description && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{r.description}</div>}
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>
              {REWARD_TYPES.find(t => t.value === r.reward_type)?.label || r.reward_type}
              {r.reward_value?.amount_minor && ` — £${(r.reward_value.amount_minor / 100).toFixed(2)}`}
              {r.reward_value?.percent && ` — ${r.reward_value.percent}%`}
              {r.total_redeemed > 0 && ` · ${r.total_redeemed} redeemed`}
            </div>
          </div>
          <div style={{ fontWeight: 800, color: 'var(--acc)', fontSize: 15, whiteSpace: 'nowrap' }}>
            {r.points_cost} pts
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => startEdit(r)} style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 11 }}>Edit</button>
            <button onClick={() => deactivate(r.id)} style={{ ...S.btn, ...S.btnDan, padding: '4px 10px', fontSize: 11 }}>Deactivate</button>
          </div>
        </div>
      ))}

      {/* Inactive rewards */}
      {inactiveRewards.length > 0 && (
        <details style={{ marginTop: 18 }}>
          <summary style={{ fontSize: 12, color: 'var(--t4)', cursor: 'pointer', marginBottom: 8 }}>
            {inactiveRewards.length} inactive reward{inactiveRewards.length !== 1 ? 's' : ''}
          </summary>
          {inactiveRewards.map(r => (
            <div key={r.id} style={{ ...S.card, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t3)' }}>{r.name}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--t4)' }}>{r.points_cost} pts</div>
              <button
                onClick={async () => {
                  try {
                    await callLoyaltyPatch('loyalty-rewards', { id: r.id, active: true });
                    onReload();
                  } catch {}
                }}
                style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 11 }}
              >
                Reactivate
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Settings Panel — points configuration
// ═══════════════════════════════════════════════════════════════════════
function SettingsPanel({ config, onUpdate }) {
  const [form, setForm] = useState({
    points_per_currency_unit: config?.points_per_currency_unit ?? 1,
    points_currency_value: config?.points_currency_value ?? 1,
    points_rounding: config?.points_rounding || 'floor',
    points_expiry_months: config?.points_expiry_months || 0,
    registration_bonus: config?.registration_bonus || 0,
    birthday_bonus: config?.birthday_bonus || 0,
    referral_bonus: config?.referral_bonus || 0,
    referral_referee_bonus: config?.referral_referee_bonus || 0,
    earn_on_gift_card_purchase: config?.earn_on_gift_card_purchase ?? false,
    earn_on_staff_discount: config?.earn_on_staff_discount ?? false,
    earn_on_comps: config?.earn_on_comps ?? false,
    earn_on_service_charge: config?.earn_on_service_charge ?? false,
    earn_on_tax: config?.earn_on_tax ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await callLoyalty('loyalty-config', form);
      onUpdate(res.config);
      setSuccess('Settings saved');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {error && <div style={S.errorBox}>{error}</div>}
      {success && <div style={S.successBox}>{success}</div>}

      {/* Points earning */}
      <div style={S.card}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>Points earning</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
          <div>
            <label style={S.label}>Points per {'£'}1 spent</label>
            <input
              style={S.input} type="number" min="0.1" step="0.1"
              value={form.points_per_currency_unit}
              onChange={e => setForm(f => ({ ...f, points_per_currency_unit: Number(e.target.value) }))}
            />
          </div>
          <div>
            <label style={S.label}>Point value (pence)</label>
            <input
              style={S.input} type="number" min="0.1" step="0.1"
              value={form.points_currency_value}
              onChange={e => setForm(f => ({ ...f, points_currency_value: Number(e.target.value) }))}
            />
            <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 4 }}>
              1 point = {form.points_currency_value || 1}p
            </div>
          </div>
          <div>
            <label style={S.label}>Rounding</label>
            <select style={S.input} value={form.points_rounding} onChange={e => setForm(f => ({ ...f, points_rounding: e.target.value }))}>
              <option value="floor">Floor (round down)</option>
              <option value="round">Round (nearest)</option>
              <option value="ceil">Ceil (round up)</option>
            </select>
          </div>
          <div>
            <label style={S.label}>Points expiry (months)</label>
            <input
              style={S.input} type="number" min="0"
              value={form.points_expiry_months}
              onChange={e => setForm(f => ({ ...f, points_expiry_months: Number(e.target.value) }))}
            />
            <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 4 }}>
              {form.points_expiry_months ? `Points expire after ${form.points_expiry_months} months` : 'Points never expire'}
            </div>
          </div>
        </div>

        {/* Example calc */}
        <div style={{ padding: '10px 14px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--t3)' }}>
          Example: A {'£'}25 order earns{' '}
          <strong style={{ color: 'var(--acc)' }}>
            {Math.floor(25 * (form.points_per_currency_unit || 1))} points
          </strong>
          {' '}(worth {'£'}{((Math.floor(25 * (form.points_per_currency_unit || 1)) * (form.points_currency_value || 1)) / 100).toFixed(2)})
        </div>
      </div>

      {/* Exclusions */}
      <div style={S.card}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>Earning rules</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <ToggleRow label="Earn on gift card purchases" checked={form.earn_on_gift_card_purchase} onChange={v => setForm(f => ({ ...f, earn_on_gift_card_purchase: v }))} />
          <ToggleRow label="Earn on staff-discounted items" checked={form.earn_on_staff_discount} onChange={v => setForm(f => ({ ...f, earn_on_staff_discount: v }))} />
          <ToggleRow label="Earn on comped items" checked={form.earn_on_comps} onChange={v => setForm(f => ({ ...f, earn_on_comps: v }))} />
          <ToggleRow label="Earn on service charge" checked={form.earn_on_service_charge} onChange={v => setForm(f => ({ ...f, earn_on_service_charge: v }))} />
          <ToggleRow label="Earn on tax" checked={form.earn_on_tax} onChange={v => setForm(f => ({ ...f, earn_on_tax: v }))} />
        </div>
      </div>

      {/* Bonuses */}
      <div style={S.card}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>Bonus points</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14 }}>
          <div>
            <label style={S.label}>Registration bonus</label>
            <input style={S.input} type="number" min="0" value={form.registration_bonus} onChange={e => setForm(f => ({ ...f, registration_bonus: Number(e.target.value) }))} />
            <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 4 }}>Given on first purchase</div>
          </div>
          <div>
            <label style={S.label}>Birthday bonus</label>
            <input style={S.input} type="number" min="0" value={form.birthday_bonus} onChange={e => setForm(f => ({ ...f, birthday_bonus: Number(e.target.value) }))} />
          </div>
          <div>
            <label style={S.label}>Referral bonus (referrer)</label>
            <input style={S.input} type="number" min="0" value={form.referral_bonus} onChange={e => setForm(f => ({ ...f, referral_bonus: Number(e.target.value) }))} />
          </div>
          <div>
            <label style={S.label}>Referral bonus (referee)</label>
            <input style={S.input} type="number" min="0" value={form.referral_referee_bonus} onChange={e => setForm(f => ({ ...f, referral_referee_bonus: Number(e.target.value) }))} />
          </div>
        </div>
      </div>

      <button onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrim, marginTop: 8 }}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  );
}

// ── Toggle row ────────────────────────────────────────────────────────
function ToggleRow({ label, checked, onChange }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr)',
        cursor: 'pointer', fontSize: 12, color: 'var(--t2)',
      }}
    >
      <div style={{
        width: 36, height: 20, borderRadius: 10, background: checked ? 'var(--grn)' : 'var(--bdr2)',
        position: 'relative', transition: 'background .2s', flexShrink: 0,
      }}>
        <div style={{
          width: 16, height: 16, borderRadius: 8, background: '#fff',
          position: 'absolute', top: 2, left: checked ? 18 : 2, transition: 'left .2s',
        }}/>
      </div>
      {label}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Members Panel — search and view loyalty members
// ═══════════════════════════════════════════════════════════════════════
function MembersPanel({ config }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    setResult(null);
    try {
      const body = { location_id: getActiveLocationSync() };
      const q = query.trim();
      if (q.startsWith('SRV-') || q.startsWith('srv-')) {
        body.member_code = q;
      } else if (/^[0-9+]/.test(q)) {
        body.phone = q;
      } else {
        // Try as customer_id UUID
        body.customer_id = q;
      }
      const data = await callLoyalty('loyalty-member-lookup', body);
      setResult(data);
    } catch (e) {
      setError(e?.message || 'Not found');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <div style={S.card}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 12 }}>Look up a member</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            style={{ ...S.input, flex: 1 }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Member code (SRV-XXXXXX), phone number, or customer ID"
          />
          <button onClick={search} disabled={searching} style={{ ...S.btn, ...S.btnPrim, whiteSpace: 'nowrap' }}>
            {searching ? 'Searching...' : 'Look up'}
          </button>
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {result && result.found && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%', background: 'var(--acc-d, var(--bg2))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 800, color: 'var(--acc)', border: '2px solid var(--acc)',
            }}>
              {(result.name || '?').charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)' }}>{result.name || 'Unknown'}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>
                {result.phone || ''} {result.email ? `· ${result.email}` : ''}
              </div>
              {result.member_code && (
                <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>
                  {result.member_code}
                </div>
              )}
            </div>
          </div>

          {/* Stats grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            <ConfigStat label="Points balance" value={result.points_balance ?? 0} />
            <ConfigStat label="Total earned" value={result.points_earned_total ?? 0} />
            <ConfigStat label="Visits" value={result.visit_count ?? 0} />
            <ConfigStat label="Lifetime spend" value={result.lifetime_spend ? `£${(result.lifetime_spend / 100).toFixed(2)}` : '£0.00'} />
          </div>

          {/* Tier */}
          {result.tier && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr)' }}>
              <span style={{ fontSize: 14 }}>{result.tier.icon || '⭐'}</span>
              <span style={{ fontWeight: 700, fontSize: 13, color: result.tier.color || 'var(--t1)' }}>{result.tier.name}</span>
              {result.tier.multiplier > 1 && (
                <span style={{ fontSize: 11, color: 'var(--t4)' }}>({result.tier.multiplier}x points)</span>
              )}
            </div>
          )}

          {/* Available rewards */}
          {result.rewards_available?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ ...S.label, marginBottom: 8 }}>Can redeem</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {result.rewards_available.map(r => (
                  <div key={r.id} style={{
                    padding: '6px 12px', borderRadius: 8, background: 'var(--grn-d, var(--bg2))',
                    border: '1px solid var(--grn-b, var(--bdr))', fontSize: 12, fontWeight: 600, color: 'var(--grn)',
                  }}>
                    {r.name} ({r.points_cost} pts)
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Gift cards */}
          {result.gift_cards?.length > 0 && (
            <div>
              <div style={{ ...S.label, marginBottom: 8 }}>Gift cards</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {result.gift_cards.map(gc => (
                  <div key={gc.id} style={{
                    padding: '6px 12px', borderRadius: 8, background: 'var(--bg2)',
                    border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--t2)',
                  }}>
                    ****{gc.last4} — {'£'}{(gc.balance / 100).toFixed(2)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dates */}
          <div style={{ display: 'flex', gap: 20, marginTop: 14, fontSize: 11, color: 'var(--t4)' }}>
            {result.enrolled_at && <span>Enrolled: {new Date(result.enrolled_at).toLocaleDateString('en-GB')}</span>}
            {result.last_visit_at && <span>Last visit: {new Date(result.last_visit_at).toLocaleDateString('en-GB')}</span>}
            {result.referral_code && <span>Referral code: {result.referral_code}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Tiers Panel — manage loyalty tiers
// ═══════════════════════════════════════════════════════════════════════
function TiersPanel({ tiers, onReload }) {
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const blank = { name: '', color: '#E8743C', icon: '⭐', min_points: '', points_multiplier: '1.0', sort_order: 0 };
  const [form, setForm] = useState(blank);

  const save = async () => {
    if (!form.name || !form.min_points) {
      setError('Name and minimum points are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Tiers don't have a dedicated edge function yet — use platform admin
      // For now, create via the loyalty-config endpoint or directly
      // TODO: Add tier CRUD to loyalty-config or create loyalty-tiers endpoint
      if (!platformSupabase) throw new Error('Platform DB not available');

      // Resolve company_id
      const locId = getActiveLocationSync();
      const { data: loc } = await platformSupabase.from('locations')
        .select('company_id')
        .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
        .limit(1).maybeSingle();
      if (!loc?.company_id) throw new Error('Could not resolve company');

      await platformSupabase.from('loyalty_tiers').insert({
        company_id: loc.company_id,
        name: form.name,
        color: form.color,
        icon: form.icon,
        min_points: Number(form.min_points),
        points_multiplier: Number(form.points_multiplier) || 1.0,
        sort_order: Number(form.sort_order) || 0,
      });
      setSuccess('Tier created');
      setCreating(false);
      setForm(blank);
      onReload();
    } catch (e) {
      setError(e?.message || 'Failed to create tier');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {error && <div style={S.errorBox}>{error}</div>}
      {success && <div style={S.successBox}>{success}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Loyalty tiers</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 2 }}>
            Tiers reward your most loyal customers with bonus point multipliers
          </div>
        </div>
        {!creating && (
          <button onClick={() => setCreating(true)} style={{ ...S.btn, ...S.btnPrim }}>+ Add tier</button>
        )}
      </div>

      {creating && (
        <div style={{ ...S.card, border: '2px solid var(--acc)', marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>New tier</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={S.label}>Name</label>
              <input style={S.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Gold" />
            </div>
            <div>
              <label style={S.label}>Min points to qualify</label>
              <input style={S.input} type="number" min="0" value={form.min_points} onChange={e => setForm(f => ({ ...f, min_points: e.target.value }))} placeholder="e.g. 500" />
            </div>
            <div>
              <label style={S.label}>Points multiplier</label>
              <input style={S.input} type="number" min="1" step="0.1" value={form.points_multiplier} onChange={e => setForm(f => ({ ...f, points_multiplier: e.target.value }))} placeholder="e.g. 1.5" />
            </div>
            <div>
              <label style={S.label}>Colour</label>
              <input style={{ ...S.input, padding: 2, height: 36 }} type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrim }}>
              {saving ? 'Saving...' : 'Create tier'}
            </button>
            <button onClick={() => { setCreating(false); setForm(blank); }} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          </div>
        </div>
      )}

      {tiers.length === 0 && !creating && (
        <div style={{ ...S.card, textAlign: 'center', padding: 28, color: 'var(--t4)', fontSize: 13 }}>
          No tiers set up. All customers earn at the base rate. Add tiers to reward your top spenders with multiplied points.
        </div>
      )}

      {tiers.map(t => (
        <div key={t.id} style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8, background: t.color || 'var(--acc)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, color: '#fff', fontWeight: 800,
          }}>
            {t.icon || '⭐'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.color || 'var(--t1)' }}>{t.name}</div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>
              Requires {t.min_points} lifetime points · {t.points_multiplier}x earning rate
            </div>
          </div>
          <button
            onClick={async () => {
              if (!confirm(`Delete tier "${t.name}"?`)) return;
              try {
                await platformSupabase.from('loyalty_tiers').delete().eq('id', t.id);
                onReload();
              } catch {}
            }}
            style={{ ...S.btn, ...S.btnDan, padding: '4px 10px', fontSize: 11 }}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Customer portal link ─────────────────────────────────────────────────
function PortalLink({ slug, enabled }) {
  const [copied, setCopied] = useState(false);
  const [copiedReg, setCopiedReg] = useState(false);
  const portalUrl = customerUrl(slug, '/account');
  const registerUrl = customerUrl(slug, '/account/register');
  const copy = () => {
    navigator.clipboard?.writeText(portalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const copyReg = () => {
    navigator.clipboard?.writeText(registerUrl);
    setCopiedReg(true);
    setTimeout(() => setCopiedReg(false), 2000);
  };
  return (
    <div style={{ padding: '14px 16px', background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--bdr)', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
        Customer loyalty portal
      </div>
      {/* Sign-in link */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: enabled ? 'var(--grn)' : 'var(--t4)' }}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>Account sign-in</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {portalUrl}
          </div>
        </div>
        <a href={portalUrl} target="_blank" rel="noopener" style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
          background: 'var(--acc-d)', border: '1px solid var(--acc-b)', color: 'var(--acc)',
          textDecoration: 'none', whiteSpace: 'nowrap',
        }}>
          Preview ↗
        </a>
        <button onClick={copy} style={{ ...S.btn, padding: '4px 10px', fontSize: 11, ...S.btnGhost, whiteSpace: 'nowrap' }}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      {/* Registration link */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: enabled ? 'var(--grn)' : 'var(--t4)' }}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>Registration / sign-up</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {registerUrl}
          </div>
        </div>
        <a href={registerUrl} target="_blank" rel="noopener" style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
          background: 'var(--acc-d)', border: '1px solid var(--acc-b)', color: 'var(--acc)',
          textDecoration: 'none', whiteSpace: 'nowrap',
        }}>
          Preview ↗
        </a>
        <button onClick={copyReg} style={{ ...S.btn, padding: '4px 10px', fontSize: 11, ...S.btnGhost, whiteSpace: 'nowrap' }}>
          {copiedReg ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 10, lineHeight: 1.5 }}>
        Share the <b>sign-up</b> link with new customers. The <b>sign-in</b> link is for existing members to check points, rewards, gift cards, and manage their profile.
      </div>
    </div>
  );
}
