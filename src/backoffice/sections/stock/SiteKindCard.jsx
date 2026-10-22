// src/backoffice/sections/stock/SiteKindCard.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7 and 5.2, contract 3.4 and 4.5): 'What this site is' in Location
// settings, beside the Drop 1 site groups card. Restaurant or shop, Central kitchen, Store room. Saved
// by stock_set_site_kind (owner of the company or Stock control All sites only; the database refuses
// everyone else and every one site company). A central kitchen becomes a supplier the other sites
// order from (its company supplier is made for it; head office ticks who can order on its supplier
// page). Stored in stock_co_site_settings.site_kind, a table only the database writes, so a manager can
// never make their own site a kitchen with a direct update. Multi site companies only, owners and
// level 'all' only: everyone else sees nothing and Location settings stays exactly today's screen.
//
// useCompanyKitchens(sc) is shared with the central kitchen screen and the recipe page: the company's
// central kitchens from the scope (scope.kitchens, or the sites whose kind is central_kitchen), else read
// from stock_co_site_settings.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase, getLocationId } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { groupsCardShows } from '../../../lib/stock/stockControlWords';
import { Btn, ErrorLine, ui } from './stockUi';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 24, marginTop: 20, marginBottom: 20 };
const KINDS = [
  { value: 'restaurant', label: 'Restaurant or shop' },
  { value: 'central_kitchen', label: 'Central kitchen' },
  { value: 'store_room', label: 'Store room' },
];
const KITCHEN_NOTE = 'Sites order from it like a supplier. Tick who can order on its supplier page.';

/**
 * The company's central kitchens: [{ id, name }]. From the scope when it carries them, else one read of
 * stock_co_site_settings (readable by any login reaching the company). [] for a one site company.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useCompanyKitchens(sc) {
  const byKind = (sc?.sites || []).filter((s) => s && s.kind === 'central_kitchen').map((s) => s.id);
  const fromScope = Array.isArray(sc?.kitchens) ? sc.kitchens : (byKind.length ? byKind : null);
  const [read, setRead] = useState(null);
  const orgId = sc?.orgId || null;
  const multi = !!sc?.multi;
  useEffect(() => {
    if (fromScope || !multi || !orgId || !supabase) return undefined;
    let live = true;
    supabase.from('stock_co_site_settings').select('location_id').eq('org_id', orgId).eq('site_kind', 'central_kitchen').limit(50)
      .then(({ data, error }) => { if (live) setRead(error ? [] : (data || []).map((r) => r.location_id)); });
    return () => { live = false; };
  }, [fromScope, multi, orgId]);
  const ids = fromScope || read || [];
  return ids.map((id) => ({ id, name: sc?.siteName?.(id) || 'Central kitchen' }));
}

export default function SiteKindCard({ locationId = null }) {
  const sc = useStockScope();
  if (!groupsCardShows(sc)) return null;
  return <SiteKind sc={sc} locationId={locationId} />;
}

function SiteKind({ sc, locationId }) {
  const showToast = useStore((s) => s.showToast);
  const [homeLoc, setHomeLoc] = useState(null);   // the signed in venue, only when no locationId was given
  const loc = locationId || homeLoc;
  const [kind, setKind] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (locationId) return undefined;
    let live = true;
    getLocationId().then((id) => { if (live) setHomeLoc(id || null); }).catch(() => {});
    return () => { live = false; };
  }, [locationId]);

  useEffect(() => {
    if (!loc || !supabase) return undefined;
    let live = true;
    supabase.from('stock_co_site_settings').select('site_kind').eq('location_id', loc).maybeSingle()
      .then(({ data }) => { if (!live) return; const k = data?.site_kind || 'restaurant'; setKind(k); setSaved(k); });
    return () => { live = false; };
  }, [loc]);

  if (!loc || kind == null) return null;
  const save = async () => {
    setBusy(true); setError(null);
    const r = await stockApi.setSiteKind(loc, kind);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    const now = r.data?.site_kind || kind;
    setKind(now); setSaved(now);
    showToast?.(now === 'central_kitchen' ? `${sc.siteName(loc) || 'This site'} is a central kitchen now. ${KITCHEN_NOTE}` : 'Saved.', 'success');
    sc.reload?.();
  };

  return (
    <div style={card}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>What this site is</h3>
      <div style={{ ...ui.sub, marginBottom: 12 }}>{sc.siteName(loc) || 'This site'}</div>
      <div role="radiogroup" aria-label="What this site is" style={{ display: 'grid', gap: 8 }}>
        {KINDS.map((k) => (
          <label key={k.value} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 14, color: 'var(--t1)' }}>
            <input type="radio" name="site-kind" value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} disabled={busy} />
            <span>
              {k.label}
              {k.value === 'central_kitchen' && <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{KITCHEN_NOTE}</span>}
            </span>
          </label>
        ))}
      </div>
      <ErrorLine error={error} />
      <div style={{ marginTop: 12 }}>
        <Btn kind="primary" onClick={save} disabled={busy || kind === saved}>{busy ? 'Saving…' : 'Save'}</Btn>
      </div>
    </div>
  );
}
