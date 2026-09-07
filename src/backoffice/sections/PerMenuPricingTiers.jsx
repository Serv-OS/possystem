/**
* PerMenuPricingTiers — v4.7.8
*
* Item-level UI for setting per-menu price overrides.
* Writes to item.pricing.menus[menuId][channel].
* The shared resolver (src/lib/menuPricing.js resolveItemPrice, which
* store.getItemPrice delegates to) reads this shape on every surface.
*
* Resolution order in resolver: menu+channel -> menu.all -> menu.base -> channel default -> base
* (menu.base is the Base field below. It was written but never read before the
* shared resolver, see menuTierPrice.)
*
* Empty input clears the channel. If all channels for a menu are empty,
* the menu key is removed from pricing.menus.
*/

import { useMemo } from 'react';
import { useStore } from '../../store';

const inp = {
  background: 'var(--bg2)',
  border: '1px solid var(--bdr)',
  borderRadius: 6,
  padding: '6px 9px',
  color: 'var(--t1)',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 'none',
};

const btn = {
  background: 'var(--bg3)',
  border: '1px solid var(--bdr)',
  borderRadius: 6,
  padding: '6px 12px',
  color: 'var(--t1)',
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

const CHANNELS = [
  { k: 'all',        label: 'Default for this menu', fb: null },
  { k: 'base',       label: 'Base',                  fb: 'base' },
  { k: 'dineIn',     label: 'Dine in',               fb: 'dineIn' },
  { k: 'takeaway',   label: 'Takeaway',              fb: 'takeaway' },
  { k: 'collection', label: 'Collection',            fb: 'collection' },
  { k: 'delivery',   label: 'Delivery',              fb: 'delivery' },
];

export default function PerMenuPricingTiers({ item, onUpdate }) {
  const allMenus = useStore(s => s.menus) || [];
  const p = item && item.pricing ? item.pricing : {};
  const tiersByMenu = p.menus || {};

  // Set a single channel within a menu tier. Empty string clears it.
  // If the menu tier becomes empty, remove the menu key entirely.
  const setTierField = (menuId, channel, v) => {
    const menusObj = Object.assign({}, tiersByMenu);
    const tier = Object.assign({}, menusObj[menuId] || {});
    if (v === '' || v === null || v === undefined) {
      delete tier[channel];
    } else {
      const num = parseFloat(v);
      tier[channel] = isNaN(num) ? 0 : num;
    }
    if (Object.keys(tier).length === 0) {
      delete menusObj[menuId];
    } else {
      menusObj[menuId] = tier;
    }
    onUpdate({ pricing: Object.assign({}, p, { menus: menusObj }) });
  };

  const removeTier = (menuId) => {
    const menusObj = Object.assign({}, tiersByMenu);
    delete menusObj[menuId];
    onUpdate({ pricing: Object.assign({}, p, { menus: menusObj }) });
  };

  const moveTier = (oldMenuId, newMenuId) => {
    if (oldMenuId === newMenuId) return;
    const menusObj = Object.assign({}, tiersByMenu);
    const data = menusObj[oldMenuId];
    delete menusObj[oldMenuId];
    menusObj[newMenuId] = data || {};
    onUpdate({ pricing: Object.assign({}, p, { menus: menusObj }) });
  };

  const addTier = () => {
    const used = new Set(Object.keys(tiersByMenu));
    const available = allMenus.filter(m => !used.has(m.id));
    if (available.length === 0) return;
    const target = available[0];
    const menusObj = Object.assign({}, tiersByMenu);
    menusObj[target.id] = {};
    onUpdate({ pricing: Object.assign({}, p, { menus: menusObj }) });
  };

  const tierEntries = useMemo(() => Object.entries(tiersByMenu), [tiersByMenu]);
  const hasAnyAvailable = useMemo(() => {
    const used = new Set(Object.keys(tiersByMenu));
    return allMenus.some(m => !used.has(m.id));
  }, [allMenus, tiersByMenu]);

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>Per-menu pricing tiers</div>
          <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 2 }}>Override prices for this item on specific menus (e.g. Deliveroo +0.50). Empty fields fall back to channel/base above.</div>
        </div>
        {hasAnyAvailable && (
          <button onClick={addTier} style={Object.assign({}, btn, { fontSize: 11, padding: '5px 10px', whiteSpace: 'nowrap' })}>+ Add menu tier</button>
        )}
      </div>

      {tierEntries.length === 0 ? (
        <div style={{ padding: '14px 12px', background: 'var(--bg2)', border: '1px dashed var(--bdr)', borderRadius: 6, fontSize: 11, color: 'var(--t3)', textAlign: 'center' }}>
          No menu tiers set. Item uses the prices above on every menu.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tierEntries.map(([menuId, tier]) => {
            const menu = allMenus.find(m => m.id === menuId);
            const remainingMenus = allMenus.filter(m => m.id === menuId || !tiersByMenu[m.id]);
            return (
              <div key={menuId} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 7, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <select value={menuId} onChange={e => moveTier(menuId, e.target.value)}
                    style={Object.assign({}, inp, { fontSize: 11.5, padding: '4px 8px', flex: 1, fontWeight: 600 })}>
                    {!menu && <option value={menuId}>(unknown menu)</option>}
                    {remainingMenus.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button onClick={() => removeTier(menuId)} title="Remove this tier"
                    style={{ background: 'none', border: '1px solid var(--bdr)', borderRadius: 5, color: 'var(--t3)', cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>x</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                  {CHANNELS.map(({ k, label, fb }) => {
                    const v = tier[k];
                    const fallbackValue = !fb ? '' : (p[fb] != null ? p[fb] : (p.base != null ? p.base : ''));
                    const placeholder = k === 'all' ? '—' : (fallbackValue !== '' ? Number(fallbackValue).toFixed(2) : '0.00');
                    return (
                      <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <label style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</label>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--t4)', fontSize: 11, pointerEvents: 'none' }}>£</span>
                          <input type="number" step="0.01" min="0"
                            value={v != null && v !== undefined ? v : ''}
                            onChange={e => setTierField(menuId, k, e.target.value)}
                            placeholder={placeholder}
                            style={Object.assign({}, inp, { paddingLeft: 18, paddingRight: 6, fontSize: 11.5, width: '100%' })}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
