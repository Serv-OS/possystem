// src/backoffice/sections/LoyaltyManager.jsx
// v5.5.218 — Back office loyalty management.
// Configuration, rewards catalog CRUD, member lookup, tier management.
// Follows the same pattern as GiftCards.jsx:
//   - callLoyalty() helper auto-injects location_id
//   - platformSupabase for location/company resolution
//   - Tab-based sub-sections

import { useState, useEffect, useCallback, useMemo } from 'react';
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
          { id: 'stamp_cards', label: 'Stamp Cards' },
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
      {tab === 'stamp_cards' && <StampCardsPanel />}
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
// Members Panel — full list of all loyalty members, searchable and filterable
// ═══════════════════════════════════════════════════════════════════════
function MembersPanel({ config }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('enrolled'); // enrolled | points | visits | spend | name
  const [sortDir, setSortDir] = useState('desc');
  const [adjustMember, setAdjustMember] = useState(null); // member obj for the adjust modal
  const [companyId, setCompanyId] = useState(null);

  // Load all members: customer_loyalty (platform) + customers (ops)
  useEffect(() => {
    (async () => {
      if (!platformSupabase || !supabase) { setLoading(false); return; }
      try {
        // Resolve company_id
        const locId = getActiveLocationSync() || await getLocationId();
        const { data: loc } = await platformSupabase.from('locations')
          .select('company_id')
          .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
          .limit(1).maybeSingle();
        if (!loc?.company_id) { setLoading(false); return; }
        setCompanyId(loc.company_id);

        // Get all loyalty memberships for this company
        const { data: loyaltyRows } = await platformSupabase
          .from('customer_loyalty')
          .select('customer_id, points_balance, points_earned_total, points_redeemed_total, visit_count, lifetime_spend_minor, member_code, tier_id, enrolled_at, last_earn_at, referral_code')
          .eq('company_id', loc.company_id)
          .order('enrolled_at', { ascending: false });

        if (!loyaltyRows?.length) { setMembers([]); setLoading(false); return; }

        // Fetch customer details from ops DB
        const custIds = loyaltyRows.map(r => r.customer_id);
        const { data: custRows } = await supabase
          .from('customers')
          .select('id, name, phone, phone_raw, email, birthday, marketing_opt_in')
          .in('id', custIds)
          .is('deleted_at', null);

        const custMap = {};
        (custRows || []).forEach(c => { custMap[c.id] = c; });

        // Get tier names
        let tierMap = {};
        const tierIds = [...new Set(loyaltyRows.filter(r => r.tier_id).map(r => r.tier_id))];
        if (tierIds.length) {
          const { data: tRows } = await platformSupabase
            .from('loyalty_tiers')
            .select('id, name, color, icon')
            .in('id', tierIds);
          (tRows || []).forEach(t => { tierMap[t.id] = t; });
        }

        // Merge
        const merged = loyaltyRows.map(l => {
          const c = custMap[l.customer_id] || {};
          return {
            ...l,
            name: c.name || null,
            phone: c.phone_raw || c.phone || null,
            email: c.email || null,
            birthday: c.birthday || null,
            tier: l.tier_id ? tierMap[l.tier_id] || null : null,
          };
        }).filter(m => custMap[m.customer_id]); // Only include members whose customer record exists

        setMembers(merged);
      } catch (err) {
        console.warn('[MembersPanel] load failed:', err?.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Filter + sort
  const filtered = useMemo(() => {
    let rows = members;
    const s = search.trim().toLowerCase();
    if (s) {
      rows = rows.filter(m =>
        (m.name || '').toLowerCase().includes(s) ||
        (m.phone || '').replace(/\s/g, '').includes(s.replace(/\s/g, '')) ||
        (m.email || '').toLowerCase().includes(s) ||
        (m.member_code || '').toLowerCase().includes(s)
      );
    }
    rows = [...rows].sort((a, b) => {
      let av, bv;
      if (sortBy === 'enrolled') { av = new Date(a.enrolled_at || 0).getTime(); bv = new Date(b.enrolled_at || 0).getTime(); }
      else if (sortBy === 'points') { av = a.points_balance || 0; bv = b.points_balance || 0; }
      else if (sortBy === 'visits') { av = a.visit_count || 0; bv = b.visit_count || 0; }
      else if (sortBy === 'spend') { av = a.lifetime_spend_minor || 0; bv = b.lifetime_spend_minor || 0; }
      else { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [members, search, sortBy, sortDir]);

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };
  const sortArrow = (col) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  if (loading) return <div style={{ padding: 40, color: 'var(--t4)', fontSize: 13 }}>Loading members…</div>;

  return (
    <div>
      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <ConfigStat label="Total members" value={members.length} />
        <ConfigStat label="Total points in circulation" value={members.reduce((s, m) => s + (m.points_balance || 0), 0).toLocaleString()} />
        <ConfigStat label="Total earned (all time)" value={members.reduce((s, m) => s + (m.points_earned_total || 0), 0).toLocaleString()} />
        <ConfigStat label="Total visits" value={members.reduce((s, m) => s + (m.visit_count || 0), 0).toLocaleString()} />
      </div>

      {/* Search */}
      <div style={{ marginBottom: 14 }}>
        <input
          style={{ ...S.input, padding: '10px 14px', fontSize: 14 }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, phone, email, or member code…"
        />
      </div>

      <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 10 }}>
        {filtered.length} member{filtered.length !== 1 ? 's' : ''}{search ? ' matching' : ''}
      </div>

      {filtered.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.3 }}>⭐</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t3)' }}>
            {members.length === 0 ? 'No loyalty members yet' : 'No matches'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 4 }}>
            {members.length === 0 ? 'Customers are auto-enrolled when they interact with the portal or POS.' : 'Try a different search term.'}
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr 0.8fr 0.8fr 0.8fr 0.7fr auto',
            gap: 6, padding: '10px 16px', fontSize: 10, fontWeight: 800, color: 'var(--t4)',
            textTransform: 'uppercase', letterSpacing: '.07em', background: 'var(--bg2)',
            borderBottom: '1px solid var(--bdr)',
          }}>
            <span onClick={() => toggleSort('name')} style={{ cursor: 'pointer', color: sortBy === 'name' ? 'var(--acc)' : undefined }}>Member{sortArrow('name')}</span>
            <span>Phone</span>
            <span>Code</span>
            <span onClick={() => toggleSort('points')} style={{ cursor: 'pointer', textAlign: 'right', color: sortBy === 'points' ? 'var(--acc)' : undefined }}>Points{sortArrow('points')}</span>
            <span onClick={() => toggleSort('visits')} style={{ cursor: 'pointer', textAlign: 'right', color: sortBy === 'visits' ? 'var(--acc)' : undefined }}>Visits{sortArrow('visits')}</span>
            <span onClick={() => toggleSort('spend')} style={{ cursor: 'pointer', textAlign: 'right', color: sortBy === 'spend' ? 'var(--acc)' : undefined }}>Spend{sortArrow('spend')}</span>
            <span onClick={() => toggleSort('enrolled')} style={{ cursor: 'pointer', textAlign: 'right', color: sortBy === 'enrolled' ? 'var(--acc)' : undefined }}>Enrolled{sortArrow('enrolled')}</span>
            <span></span>
          </div>
          {/* Rows */}
          {filtered.map(m => (
            <div key={m.customer_id} style={{
              display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr 0.8fr 0.8fr 0.8fr 0.7fr auto',
              gap: 6, padding: '10px 16px', fontSize: 12, alignItems: 'center',
              borderBottom: '1px solid var(--bdr)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name || 'Unnamed'}
                  {m.tier && (
                    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: `${m.tier.color || 'var(--acc)'}20`, color: m.tier.color || 'var(--acc)' }}>
                      {m.tier.icon || '⭐'} {m.tier.name}
                    </span>
                  )}
                </div>
                {m.email && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.email}</div>}
              </div>
              <div style={{ color: 'var(--t2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{m.phone || '—'}</div>
              <div style={{ color: 'var(--t4)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{m.member_code || '—'}</div>
              <div style={{ textAlign: 'right', color: 'var(--acc)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{(m.points_balance || 0).toLocaleString()}</div>
              <div style={{ textAlign: 'right', color: 'var(--t1)', fontFamily: 'var(--font-mono)' }}>{m.visit_count || 0}</div>
              <div style={{ textAlign: 'right', color: 'var(--t2)', fontFamily: 'var(--font-mono)' }}>£{((m.lifetime_spend_minor || 0) / 100).toFixed(2)}</div>
              <div style={{ textAlign: 'right', color: 'var(--t3)', fontSize: 11 }}>{m.enrolled_at ? new Date(m.enrolled_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—'}</div>
              <button onClick={() => setAdjustMember(m)} style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6,
                border: '1px solid var(--bdr)', background: 'var(--bg3)', color: 'var(--t2)',
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}>± Points</button>
            </div>
          ))}
        </div>
      )}

      {/* Adjust Points Modal */}
      {adjustMember && (
        <AdjustPointsModal
          member={adjustMember}
          companyId={companyId}
          onClose={() => setAdjustMember(null)}
          onSaved={(custId, newBalance, delta) => {
            setMembers(ms => ms.map(m => {
              if (m.customer_id !== custId) return m;
              return {
                ...m,
                points_balance: newBalance,
                points_earned_total: delta > 0 ? (m.points_earned_total || 0) + delta : m.points_earned_total,
                points_redeemed_total: delta < 0 ? (m.points_redeemed_total || 0) + Math.abs(delta) : m.points_redeemed_total,
              };
            }));
            setAdjustMember(null);
          }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Adjust Points Modal — manual add/remove points for a member
// ═══════════════════════════════════════════════════════════════════════
function AdjustPointsModal({ member, companyId, onClose, onSaved }) {
  const [mode, setMode] = useState('add'); // add | remove
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const pts = parseInt(amount, 10) || 0;
  const delta = mode === 'add' ? pts : -pts;
  const newBalance = (member.points_balance || 0) + delta;
  const valid = pts > 0 && (mode === 'add' || newBalance >= 0);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      // 1. Update points_balance on platform DB
      const { data: current, error: readErr } = await platformSupabase
        .from('customer_loyalty')
        .select('id, points_balance, points_earned_total, points_redeemed_total')
        .eq('customer_id', member.customer_id)
        .eq('company_id', companyId)
        .single();
      if (readErr || !current) throw new Error('Could not find loyalty record');

      const updatedBalance = current.points_balance + delta;
      if (updatedBalance < 0) throw new Error('Insufficient points');

      const updates = { points_balance: updatedBalance };
      if (delta > 0) {
        updates.points_earned_total = (current.points_earned_total || 0) + pts;
        updates.last_earn_at = new Date().toISOString();
      } else {
        updates.points_redeemed_total = (current.points_redeemed_total || 0) + Math.abs(delta);
        updates.last_redeem_at = new Date().toISOString();
      }

      const { error: upErr } = await platformSupabase
        .from('customer_loyalty')
        .update(updates)
        .eq('id', current.id);
      if (upErr) throw new Error(upErr.message);

      // 2. Write transaction to ops DB ledger
      const locId = getActiveLocationSync() || await getLocationId();
      await supabase.from('loyalty_transactions').insert({
        customer_id: member.customer_id,
        company_id: companyId,
        location_id: locId,
        type: delta > 0 ? 'earn' : 'redeem',
        points: Math.abs(delta),
        balance_after: updatedBalance,
        source: 'manual_adjust',
        note: reason.trim() || `Manual ${mode} by staff`,
        idempotency_key: `manual:${member.customer_id}:${Date.now()}`,
      });

      onSaved(member.customer_id, updatedBalance, delta);
    } catch (e) {
      setError(e.message || 'Failed to adjust points');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 420, background: 'var(--bg1)', border: '1px solid var(--bdr)',
        borderRadius: 14, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,.3)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>
          Adjust points
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>
          {member.name || 'Unnamed'} · Current balance: <b style={{ color: 'var(--acc)' }}>{(member.points_balance || 0).toLocaleString()} pts</b>
        </div>

        {/* Add / Remove toggle */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
          {['add', 'remove'].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              flex: 1, padding: '10px 0', border: 'none', fontFamily: 'inherit',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
              background: mode === m ? (m === 'add' ? 'var(--grn,#4caf50)' : 'var(--red,#cc5959)') : 'var(--bg2)',
              color: mode === m ? '#fff' : 'var(--t3)',
            }}>
              {m === 'add' ? '+ Add points' : '− Remove points'}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
          Points
        </div>
        <input
          type="number"
          min="1"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="e.g. 50"
          autoFocus
          style={{ ...S.input, padding: '12px 14px', fontSize: 16, fontFamily: 'var(--font-mono)', marginBottom: 14 }}
        />

        {/* Reason */}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
          Reason (optional)
        </div>
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. Forgot to scan on last visit"
          style={{ ...S.input, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}
        />

        {/* Preview */}
        {pts > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 16,
            background: mode === 'add' ? 'rgba(76,175,80,.08)' : 'rgba(204,89,89,.08)',
            border: `1px solid ${mode === 'add' ? 'rgba(76,175,80,.2)' : 'rgba(204,89,89,.2)'}`,
            fontSize: 13, color: 'var(--t2)',
          }}>
            {member.points_balance || 0} {mode === 'add' ? '+' : '−'} {pts} = <b style={{ color: mode === 'add' ? 'var(--grn,#4caf50)' : 'var(--red,#cc5959)' }}>{newBalance} pts</b>
            {mode === 'remove' && newBalance < 0 && (
              <div style={{ fontSize: 11, color: 'var(--red,#cc5959)', marginTop: 4 }}>Cannot go below zero</div>
            )}
          </div>
        )}

        {error && <div style={{ fontSize: 12, color: 'var(--red,#cc5959)', marginBottom: 12 }}>{error}</div>}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '10px 18px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--bg3)', color: 'var(--t2)', fontSize: 13, fontWeight: 700,
            fontFamily: 'inherit', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={submit} disabled={!valid || saving} style={{
            padding: '10px 22px', borderRadius: 8, border: 'none',
            background: valid && !saving ? (mode === 'add' ? 'var(--grn,#4caf50)' : 'var(--red,#cc5959)') : 'var(--bg3)',
            color: valid && !saving ? '#fff' : 'var(--t4)',
            fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
            cursor: valid && !saving ? 'pointer' : 'not-allowed',
            opacity: saving ? 0.6 : 1,
          }}>
            {saving ? 'Saving…' : mode === 'add' ? `Add ${pts || 0} points` : `Remove ${pts || 0} points`}
          </button>
        </div>
      </div>
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
// ── Stamp Cards Panel ──────────────────────────────────────────────────
const STAMP_ICONS = ['☕','🍕','🍔','🥗','🍺','🍷','🧁','🍩','🥪','🌮','🍣','🎂','⭐','❤️','🔥','🎯'];

function StampCardsPanel() {
  const [programs, setPrograms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // null = list view, 'new' = create, program object = edit
  const [companyId, setCompanyId] = useState(null);
  const [categories, setCategories] = useState([]);

  // Load programs + categories
  useEffect(() => {
    (async () => {
      try {
        const locId = getActiveLocationSync() || await getLocationId();
        // Resolve company_id
        if (platformSupabase && locId) {
          const { data: loc } = await platformSupabase
            .from('locations')
            .select('company_id')
            .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
            .limit(1).maybeSingle();
          if (loc?.company_id) {
            setCompanyId(loc.company_id);
            // Fetch stamp card programs
            const { data: progs } = await platformSupabase
              .from('stamp_card_programs')
              .select('*')
              .eq('company_id', loc.company_id)
              .order('created_at', { ascending: false });
            setPrograms(progs || []);
          }
        }
        // Fetch menu categories for qualifier picker
        if (supabase && locId) {
          const { data: cats } = await supabase
            .from('menu_categories')
            .select('id, label, parent_id')
            .eq('location_id', locId)
            .order('sort_order');
          setCategories(cats || []);
        }
      } catch (e) {
        console.error('[StampCards] load:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const reload = async () => {
    if (!platformSupabase || !companyId) return;
    const { data } = await platformSupabase
      .from('stamp_card_programs')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    setPrograms(data || []);
  };

  if (loading) return <div style={{ padding: 20, color: 'var(--t4)', fontSize: 13 }}>Loading stamp cards...</div>;

  if (editing) {
    return (
      <StampCardForm
        program={editing === 'new' ? null : editing}
        companyId={companyId}
        categories={categories}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); }}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Stamp Card Programs</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 2 }}>
            Create "buy X get 1 free" cards to reward repeat purchases
          </div>
        </div>
        <button
          onClick={() => setEditing('new')}
          style={{ ...S.btn, ...S.btnPrim, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          + New stamp card
        </button>
      </div>

      {programs.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>☕</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 }}>No stamp cards yet</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', maxWidth: 320, margin: '0 auto', lineHeight: 1.5 }}>
            Create your first stamp card to reward loyal customers. For example: "Buy 9 coffees, get 1 free!"
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {programs.map(p => (
            <StampCardRow key={p.id} program={p} onEdit={() => setEditing(p)} onToggle={async () => {
              await platformSupabase.from('stamp_card_programs').update({ active: !p.active, updated_at: new Date().toISOString() }).eq('id', p.id);
              reload();
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

function StampCardRow({ program: p, onEdit, onToggle }) {
  const catCount = (p.qualifying_category_ids || []).length;
  return (
    <div style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 14, padding: 16, marginBottom: 0 }}>
      <div style={{ width: 48, height: 48, borderRadius: 12, background: p.active ? 'var(--acc-d)' : 'var(--bg3)',
        border: `1px solid ${p.active ? 'var(--acc-b)' : 'var(--bdr)'}`, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>
        {p.icon || '☕'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{p.name}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
          Collect {p.stamps_required} stamps → {p.reward_description || 'Free item'}
        </div>
        {catCount > 0 && (
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>
            {catCount} qualifying {catCount === 1 ? 'category' : 'categories'}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{
          padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: p.active ? 'var(--grn-d)' : 'var(--bg3)',
          color: p.active ? 'var(--grn)' : 'var(--t4)',
          border: `1px solid ${p.active ? 'var(--grn-b, var(--grn))' : 'var(--bdr)'}`,
        }}>
          {p.active ? 'Active' : 'Paused'}
        </span>
        <button onClick={onToggle} style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 11 }}>
          {p.active ? 'Pause' : 'Activate'}
        </button>
        <button onClick={onEdit} style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 11 }}>
          Edit
        </button>
      </div>
    </div>
  );
}

function StampCardForm({ program, companyId, categories, onClose, onSaved }) {
  const isNew = !program;
  const [name, setName] = useState(program?.name || '');
  const [description, setDescription] = useState(program?.description || '');
  const [icon, setIcon] = useState(program?.icon || '☕');
  const [stampsRequired, setStampsRequired] = useState(program?.stamps_required || 10);
  const [rewardType, setRewardType] = useState(program?.reward_type || 'free_item');
  const [rewardDescription, setRewardDescription] = useState(program?.reward_description || '');
  const [selectedCatIds, setSelectedCatIds] = useState(program?.qualifying_category_ids || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showIconPicker, setShowIconPicker] = useState(false);

  const toggleCat = (catId) => {
    setSelectedCatIds(prev =>
      prev.includes(catId) ? prev.filter(id => id !== catId) : [...prev, catId]
    );
  };

  const save = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (stampsRequired < 2 || stampsRequired > 50) { setError('Stamps required must be between 2 and 50'); return; }
    if (!companyId) { setError('Company not resolved'); return; }
    setSaving(true);
    setError('');
    try {
      const row = {
        company_id: companyId,
        name: name.trim(),
        description: description.trim() || null,
        icon,
        stamps_required: Number(stampsRequired),
        reward_type: rewardType,
        reward_description: rewardDescription.trim() || null,
        qualifying_category_ids: selectedCatIds,
        updated_at: new Date().toISOString(),
      };
      if (isNew) {
        const { error: e } = await platformSupabase.from('stamp_card_programs').insert(row);
        if (e) throw e;
      } else {
        const { error: e } = await platformSupabase.from('stamp_card_programs').update(row).eq('id', program.id);
        if (e) throw e;
      }
      onSaved();
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const deleteProgram = async () => {
    if (!program?.id) return;
    if (!confirm('Delete this stamp card program? Customer progress will be lost.')) return;
    try {
      // Delete customer cards first, then the program. If program delete fails,
      // orphaned customer cards are harmless (no FK, just dangling data).
      const { error: cardsErr } = await platformSupabase.from('customer_stamp_cards').delete().eq('program_id', program.id);
      if (cardsErr) throw cardsErr;
      const { error: progErr } = await platformSupabase.from('stamp_card_programs').delete().eq('id', program.id);
      if (progErr) throw progErr;
      onSaved();
    } catch (e) {
      setError(e?.message || 'Delete failed');
    }
  };

  // Separate top-level and subcategories
  const topCats = categories.filter(c => !c.parent_id);
  const subCats = categories.filter(c => c.parent_id);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button onClick={onClose} style={{ ...S.btn, ...S.btnGhost, padding: '6px 12px', fontSize: 12 }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>
          {isNew ? 'Create Stamp Card' : `Edit: ${program.name}`}
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      <div style={S.card}>
        {/* Icon + Name row */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ position: 'relative' }}>
            <label style={S.label}>Icon</label>
            <button
              onClick={() => setShowIconPicker(!showIconPicker)}
              style={{
                width: 52, height: 52, borderRadius: 12, border: '2px solid var(--bdr2)',
                background: 'var(--bg2)', fontSize: 28, cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              {icon}
            </button>
            {showIconPicker && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 10, marginTop: 4,
                padding: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10,
                boxShadow: 'var(--sh2)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
              }}>
                {STAMP_ICONS.map(ic => (
                  <button key={ic} onClick={() => { setIcon(ic); setShowIconPicker(false); }}
                    style={{
                      width: 36, height: 36, borderRadius: 8, border: ic === icon ? '2px solid var(--acc)' : '1px solid var(--bdr)',
                      background: ic === icon ? 'var(--acc-d)' : 'var(--bg2)', fontSize: 20, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Card name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Coffee Loyalty Card" style={S.input} />
          </div>
        </div>

        {/* Description */}
        <div style={{ marginBottom: 16 }}>
          <label style={S.label}>Description (optional)</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Buy 9 coffees, get your 10th free!" style={S.input} />
        </div>

        {/* Stamps required + Reward row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
          <div>
            <label style={S.label}>Stamps to collect</label>
            <input type="number" min={2} max={50} value={stampsRequired}
              onChange={e => setStampsRequired(e.target.value)}
              style={S.input} />
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>
              Customer collects {stampsRequired} stamps, then gets the reward
            </div>
          </div>
          <div>
            <label style={S.label}>Reward type</label>
            <select value={rewardType} onChange={e => setRewardType(e.target.value)}
              style={{ ...S.input, cursor: 'pointer' }}>
              <option value="free_item">Free item</option>
              <option value="discount_percent">% Discount</option>
              <option value="discount_fixed">£ Discount</option>
              <option value="bonus_points">Bonus points</option>
            </select>
          </div>
        </div>

        {/* Reward description */}
        <div style={{ marginBottom: 16 }}>
          <label style={S.label}>Reward description</label>
          <input value={rewardDescription} onChange={e => setRewardDescription(e.target.value)}
            placeholder={rewardType === 'free_item' ? 'e.g. 1 free coffee' : rewardType === 'discount_percent' ? 'e.g. 20% off next order' : rewardType === 'bonus_points' ? 'e.g. 500 bonus points' : 'e.g. £5 off next order'}
            style={S.input} />
        </div>

        {/* Qualifying categories */}
        <div style={{ marginBottom: 16 }}>
          <label style={S.label}>Qualifying categories</label>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 8, lineHeight: 1.4 }}>
            Select which menu categories earn stamps. If none are selected, <b>all items</b> qualify.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {topCats.map(cat => {
              const isSelected = selectedCatIds.includes(cat.id);
              const children = subCats.filter(sc => sc.parent_id === cat.id);
              return (
                <div key={cat.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button
                    onClick={() => toggleCat(cat.id)}
                    style={{
                      padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${isSelected ? 'var(--acc)' : 'var(--bdr2)'}`,
                      background: isSelected ? 'var(--acc-d)' : 'var(--bg2)',
                      color: isSelected ? 'var(--acc)' : 'var(--t3)',
                    }}
                  >
                    {cat.label}
                  </button>
                  {children.map(sc => {
                    const subSel = selectedCatIds.includes(sc.id);
                    return (
                      <button key={sc.id}
                        onClick={() => toggleCat(sc.id)}
                        style={{
                          padding: '3px 10px', borderRadius: 16, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                          marginLeft: 12,
                          border: `1px solid ${subSel ? 'var(--acc)' : 'var(--bdr)'}`,
                          background: subSel ? 'var(--acc-d)' : 'transparent',
                          color: subSel ? 'var(--acc)' : 'var(--t4)',
                        }}
                      >
                        {sc.label}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {selectedCatIds.length > 0 && (
            <button onClick={() => setSelectedCatIds([])} style={{ ...S.btn, fontSize: 11, color: 'var(--t4)', background: 'transparent', padding: '4px 0', marginTop: 6 }}>
              Clear selection (all items qualify)
            </button>
          )}
        </div>

        {/* Preview */}
        <div style={{ marginBottom: 20 }}>
          <label style={S.label}>Preview</label>
          <StampCardPreview icon={icon} name={name || 'Coffee Card'} stampsRequired={Number(stampsRequired) || 10}
            stampsCollected={Math.floor((Number(stampsRequired) || 10) * 0.6)}
            reward={rewardDescription || 'Free item'} />
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrim, flex: 1 }}>
            {saving ? 'Saving...' : isNew ? 'Create stamp card' : 'Save changes'}
          </button>
          {!isNew && (
            <button onClick={deleteProgram} style={{ ...S.btn, ...S.btnDan }}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}

function StampCardPreview({ icon, name, stampsRequired, stampsCollected, reward }) {
  const stamps = [];
  for (let i = 0; i < stampsRequired; i++) {
    stamps.push(i < stampsCollected);
  }
  // Add the reward slot
  const cols = Math.min(stampsRequired + 1, 6);
  return (
    <div style={{
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      borderRadius: 14, padding: 18, maxWidth: 380,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#fff' }}>{name}</div>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6,
      }}>
        {stamps.map((filled, i) => (
          <div key={i} style={{
            aspectRatio: '1', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: filled ? 'rgba(232,116,60,0.2)' : 'rgba(255,255,255,0.06)',
            border: filled ? '2px solid #E8743C' : '2px dashed rgba(255,255,255,0.15)',
            fontSize: filled ? 16 : 11,
            color: filled ? '#E8743C' : 'rgba(255,255,255,0.25)',
          }}>
            {filled ? icon : i + 1}
          </div>
        ))}
        {/* Reward slot */}
        <div style={{
          aspectRatio: '1', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(232,116,60,0.1)', border: '2px solid rgba(232,116,60,0.4)',
          fontSize: 14, flexDirection: 'column', gap: 2,
        }}>
          <span style={{ fontSize: 16 }}>🎁</span>
        </div>
      </div>
      <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
        {stampsCollected}/{stampsRequired} stamps collected · Reward: {reward}
      </div>
    </div>
  );
}

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
      {/* Wallet info */}
      <div style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 8,
        background: 'var(--bg3)', border: '1px solid var(--bdr)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)', marginBottom: 4 }}>
          📱 Apple Wallet & Google Wallet
        </div>
        <div style={{ fontSize: 11, color: 'var(--t4)', lineHeight: 1.5 }}>
          Loyalty members can add their card to Apple Wallet or Google Wallet from the customer portal or during online checkout sign-in. No setup needed — it's automatic.
        </div>
      </div>
    </div>
  );
}
