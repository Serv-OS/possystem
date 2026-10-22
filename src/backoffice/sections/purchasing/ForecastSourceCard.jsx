// purchasing/ForecastSourceCard.jsx: a new site borrows a similar site's sales until it has 4 weeks of
// its own (multi site stock Drop 3, v5.11.96, contract 3.2 and 4.2). Company editors only; the
// caller shows it while the site has under 28 venue days of its own sales.

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { Btn, Field, ui } from '../stock/stockUi';

export default function ForecastSourceCard({ siteId, borrowed = null, onSaved }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [from, setFrom] = useState(borrowed?.from_location_id || '');
  const [scale, setScale] = useState(borrowed?.scale != null ? String(borrowed.scale) : '1');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(null);
  const others = (sc.sites || []).filter((s) => s.id !== siteId);
  // The saved row's version (the save refuses an edit without it). stockApi has no read for this
  // table yet (listed for the integrator), so it is read here; the row is readable by site reach.
  useEffect(() => {
    let on = true;
    if (!supabase || !siteId) return undefined;
    supabase.from('stock_co_site_forecast_source').select('borrow_from_location_id, scale, row_version').eq('location_id', siteId).maybeSingle()
      .then(({ data }) => { if (on && data) { setVersion(data.row_version); setFrom(data.borrow_from_location_id || ''); setScale(String(data.scale ?? 1)); } }, () => {});
    return () => { on = false; };
  }, [siteId]);
  const save = async () => {
    const n = Number(scale);
    if (from && !(n > 0 && n <= 10)) { showToast?.('Scale is a number above 0 and up to 10.', 'error'); return; }
    setBusy(true);
    const r = await stockApi.saveForecastSource(siteId, from || null, from ? n : null, version);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.(from ? `Borrowing sales from ${sc.siteName(from)}.` : 'No longer borrowing sales.', 'success');
    onSaved?.();
  };
  return (
    <div style={{ ...ui.card, padding: 16, borderRadius: 14, marginTop: 16, maxWidth: 560 }}>
      <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 10 }}>A new site borrows a similar site's sales until it has 4 weeks of its own.</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Borrow sales from" style={{ marginBottom: 0 }}>
          <select value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...ui.input, width: 220 }} aria-label="Borrow sales from">
            <option value="">Nobody</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Scale" style={{ marginBottom: 0 }}>
          <input inputMode="decimal" value={scale} onChange={(e) => setScale(e.target.value)} disabled={!from} style={{ ...ui.input, width: 90 }} aria-label="Scale" />
        </Field>
        <Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn>
      </div>
    </div>
  );
}
