// src/backoffice/sections/produce/KitchenPlan.jsx
//
// MULTI SITE STOCK Drop 3 (mockup scrKitchen, contract 3.4 and 4.4): the central kitchen's production
// plan for one day (stock_kitchen_plan). One row per batch recipe made here: Ordered by sites, Catering
// due, Standing forecast, Kitchen holds, Make, Done. The name expands to the order per site. Done is a
// tick with a quantity and who ticked it (stock_kitchen_tick; today's ticks can be taken back with
// stock_kitchen_untick). A tick is a note of work done, never a stock number: the batch itself is
// recorded where batches are recorded.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { planRow, planTotals, bySiteWords, fillWords, qtyUnit, tickQty, tickWords } from '../../../lib/stock/kitchenRules';
import { Btn, TableWrap, Th, Td, ErrorLine, EmptyLine, Popover, ui } from '../stock/stockUi';

const timeOf = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''; };

export default function KitchenPlan({ kitchenId, day }) {
  const showToast = useStore((s) => s.showToast);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);        // recipe id expanded
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    stockApi.kitchenPlan(kitchenId, day).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setRows([]); return; }
      const d = r.data;
      setError(null);
      setRows(Array.isArray(d) ? d : (Array.isArray(d?.rows) ? d.rows : []));
    });
    return () => { live = false; };
  }, [kitchenId, day, reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  const tick = async (row) => {
    const n = tickQty(qty === '' ? row.left : qty);
    if (n == null) { showToast?.(`${row.name}: type how much was made.`, 'error'); return false; }
    setBusy(true);
    const r = await stockApi.kitchenTick(kitchenId, row.recipeId, n, day);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message || 'It did not save.', 'error'); return false; }
    setQty('');
    showToast?.(`${row.name}: ${qtyUnit(n, row.unit)} ticked done.`, 'success');
    reload();
    return true;
  };
  const untick = async (t) => {
    setBusy(true);
    const r = await stockApi.kitchenUntick(t.id);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message || 'It did not save.', 'error'); return; }
    reload();
  };

  if (rows === null) return <div style={{ padding: 16, color: 'var(--t3)' }}>Loading…</div>;
  const list = rows.map(planRow);
  const totals = planTotals(rows);

  return (
    <div>
      <ErrorLine error={error} />
      {!error && list.length === 0 && <EmptyLine>Nothing to make for this day. Batch recipes made here show once a site orders them, catering is due, or a standing order needs them.</EmptyLine>}
      {list.length > 0 && (
        <>
          <div style={{ ...ui.sub, marginBottom: 8 }}>{totals.done} of {totals.toMake} done</div>
          <TableWrap minWidth={760}>
            <thead><tr>
              <Th>Batch recipe</Th><Th right>Ordered by sites</Th><Th right>Catering due</Th><Th right>Standing forecast</Th><Th right>Kitchen holds</Th><Th right>Make</Th><Th>Done</Th>
            </tr></thead>
            <tbody>
              {list.map((r) => (
                <FragmentRow key={r.recipeId || r.name} r={r} open={open === r.recipeId} onToggle={() => setOpen(open === r.recipeId ? null : r.recipeId)}>
                  <Td>
                    {r.make > 0 && r.left > 0 ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Popover label="Done" kind="soft" ariaLabel={`Done for ${r.name}`} width={240}>
                          {(close) => (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <input type="number" min="0" step="any" defaultValue={r.left} onChange={(e) => setQty(e.target.value)} onFocus={(e) => setQty(e.target.value)}
                                aria-label="How much was made" style={{ ...ui.input, width: 90 }} />
                              <span style={ui.sub}>{r.unit}</span>
                              <Btn small kind="primary" disabled={busy} onClick={async () => { if (await tick(r)) close(); }}>Save</Btn>
                            </div>
                          )}
                        </Popover>
                        <span style={{ ...ui.sub }}>{fillWords(r)}</span>
                      </span>
                    ) : <span style={{ color: r.make > 0 ? 'var(--acc)' : 'var(--t3)', fontWeight: 700 }}>{fillWords(r)}</span>}
                  </Td>
                </FragmentRow>
              ))}
            </tbody>
          </TableWrap>
          {list.some((r) => r.ticks.length) && (
            <div style={{ ...ui.card, marginTop: 12 }}>
              <div style={{ fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Done today</div>
              {list.filter((r) => r.ticks.length).map((r) => (
                <div key={r.recipeId} style={{ fontSize: 13, color: 'var(--t2)', marginTop: 4 }}>
                  <b>{r.name}</b>: {r.ticks.map((t) => (
                    <span key={t.id} style={{ marginRight: 10 }}>
                      {tickWords(t, timeOf)}
                      {t.id && t.done_at && String(t.done_at).slice(0, 10) >= day && <Btn small kind="link" disabled={busy} onClick={() => untick(t)}>Take back</Btn>}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One plan row plus its expand row ('<site> 72 · <site> 36').
function FragmentRow({ r, open, onToggle, children }) {
  return (
    <>
      <tr>
        <Td><Btn small kind="link" onClick={onToggle} aria-expanded={open} style={{ paddingLeft: 0 }}>{open ? 'Hide' : 'Show'} sites</Btn> <b>{r.name}</b></Td>
        <Td num>{qtyUnit(r.ordered, r.unit)}</Td>
        <Td num>{r.catering}</Td>
        <Td num>{r.standing}</Td>
        <Td num>{r.holds}</Td>
        <Td num strong>{qtyUnit(r.make, r.unit)}</Td>
        {children}
      </tr>
      {open && (
        <tr><td colSpan={7} style={{ ...ui.td, color: 'var(--t2)' }}>{bySiteWords(r.bySite) || 'No site has ordered it for this day.'}</td></tr>
      )}
    </>
  );
}
