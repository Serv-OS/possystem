// src/surfaces/manager/ManagerKitchenCentral.jsx
//
// MULTI SITE STOCK Drop 3 (contract 3.4, design 2.14, map 4.23 O7): central kitchen staff on the phone.
// Shown only at a central kitchen (the snapshot's kitchen.ordersIn). Three tabs:
//   * Orders in: every site's order placed with this kitchen for today (kitchen.orders_in). Kitchen
//     staff never see other sites' other orders.
//   * Production plan: Make per batch recipe (ordered by sites + catering + standing, less what the
//     kitchen holds) and the Done ticks with who (kitchen.done; a tick is not a stock number).
//   * Pick and send: per site order, the packs sent per line (short when less), then Send
//     (kitchen.pick: one transfer, the 'out' leg; stock is in transit until the site receives it, and
//     the site receives it in Transfers). The delivery note and labels print from Back Office.
// Any staff PIN opens Orders in and the plan; Pick and send needs a manager PIN (the server checks).

import { useCallback, useEffect, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { planRow, bySiteWords, fillWords, qtyUnit, tickQty, tickWords, pickLines, shortLines, sentAsOrdered, ordersInStatus, lotWords } from '../../lib/stock/kitchenRules';
import { SheetFrame, PinGate, box, btn, card } from './ManagerTransfers';
import { mono } from './ui';

const TABS = [['orders', 'Orders in'], ['plan', 'Production plan'], ['pick', 'Pick and send']];
const isPinErr = (m) => /pin|not allowed|approve/i.test(String(m || ''));

export default function ManagerKitchenCentral({ ctx, onClose, tab: firstTab = 'orders' }) {
  const { loc, refreshSnap } = ctx;
  const [pin, setPin] = useState('');
  const [tab, setTab] = useState(firstTab);
  const [orders, setOrders] = useState(null);
  const [plan, setPlan] = useState(null);
  const [tick, setTick] = useState({});            // recipe id -> typed qty
  const [sent, setSent] = useState({});            // po id -> { line id -> packs }
  const [openPo, setOpenPo] = useState(null);
  const [picked, setPicked] = useState({});        // po id -> pick answer (lots, short lines)
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useCallback((action, target, extra) => managerApprove(loc, pin, action, target, extra), [loc, pin]);
  const fail = (r, fallback) => { const m = r?.error || fallback; if (isPinErr(m)) setPin(''); setErr(m); };

  const [reloads, setReloads] = useState(0);
  const load = () => setReloads((n) => n + 1);
  useEffect(() => {
    if (!pin) return undefined;
    let live = true;
    Promise.all([call('kitchen.orders_in', null, {}), call('kitchen.plan', null, {})]).then(([o, p]) => {
      if (!live) return;
      const bad = (r, fallback) => { const m = r?.error || fallback; if (isPinErr(m)) setPin(''); setErr(m); };
      if (o?.ok) setOrders(Array.isArray(o.orders) ? o.orders : []); else bad(o, 'Could not read the orders');
      if (p?.ok) setPlan(Array.isArray(p.rows) ? p.rows : []); else if (o?.ok) bad(p, 'Could not read the plan');
    });
    return () => { live = false; };
  }, [pin, call, reloads]);

  const doTick = async (row) => {
    const qty = tickQty(tick[row.recipeId]);
    if (qty == null) { setErr(`${row.name}: type how much was made.`); return; }
    setBusy(true); setErr(''); setMsg('');
    const r = await call('kitchen.done', null, { recipe_id: row.recipeId, qty });
    setBusy(false);
    if (r?.ok) { setMsg(`${row.name}: ${qtyUnit(qty, row.unit)} ticked done.`); setTick((m) => ({ ...m, [row.recipeId]: '' })); load(); } else fail(r, 'Could not tick it');
  };

  const doPick = async (o) => {
    const { lines, error } = pickLines(o, sent[o.po_id] || {});
    if (error) { setErr(error); return; }
    setBusy(true); setErr(''); setMsg('');
    const r = await call('kitchen.pick', o.po_id, { lines });
    setBusy(false);
    if (r?.ok) {
      setPicked((m) => ({ ...m, [o.po_id]: r }));
      const short = Array.isArray(r.short_lines) ? r.short_lines.length : 0;
      setMsg(`Sent ${r.reference || ''} to ${o.site_name || 'the site'}${short ? `, ${short} line${short === 1 ? '' : 's'} short` : ''}. In transit until they receive it.`);
      setOpenPo(null); load(); refreshSnap?.();
    } else fail(r, 'Could not send it');
  };

  if (!pin) return <SheetFrame title="Central kitchen" sub="Orders in, production plan, pick and send" onClose={onClose}><PinGate onPin={setPin} words="Staff PIN to open this" /></SheetFrame>;
  const rows = (plan || []).map(planRow);
  const toPick = (orders || []).filter((o) => !o.transfer_id && String(o.status || '').toUpperCase() === 'SENT');

  return (
    <SheetFrame title="Central kitchen" sub="Orders in, production plan, pick and send" onClose={onClose}>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => { setTab(k); setErr(''); setMsg(''); }} className="sv-glass"
            style={{ ...btn(tab === k ? 'var(--acc)' : 'var(--t2)'), border: tab === k ? '1px solid var(--acc)' : '1px solid var(--bdr)' }}>{label}</button>
        ))}
      </div>
      {msg && <div style={{ marginTop: 10, color: 'var(--grn)', fontWeight: 700, fontSize: 13 }}>{msg}</div>}
      {err && <div role="alert" style={{ marginTop: 10, color: 'var(--red)', fontWeight: 700, fontSize: 13 }}>{err}</div>}

      {tab === 'orders' && (
        <>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10 }}>Only orders placed with this kitchen.</div>
          {orders === null && !err && <div style={{ color: 'var(--t3)', marginTop: 10, ...mono }}>Loading…</div>}
          {orders && orders.length === 0 && <div className="sv-glass" style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>No orders for today.</div>}
          {(orders || []).map((o) => (
            <div key={o.po_id} className="sv-glass" style={card}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 800 }}>{o.site_name || 'Site'}{o.reference ? <span style={{ color: 'var(--t3)', fontWeight: 600 }}> · {o.reference}</span> : null}</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)', ...mono }}>{ordersInStatus(o)}</span>
              </div>
              {(o.lines || []).map((l) => (
                <div key={l.po_line_id} style={{ fontSize: 12, color: 'var(--t2)', marginTop: 4, ...mono }}>{l.qty_packs} x {l.name}{l.pack_label ? ` (${l.pack_label})` : ''}</div>
              ))}
            </div>
          ))}
        </>
      )}

      {tab === 'plan' && (
        <>
          {plan === null && !err && <div style={{ color: 'var(--t3)', marginTop: 10, ...mono }}>Loading…</div>}
          {plan && rows.length === 0 && <div className="sv-glass" style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>Nothing to make today.</div>}
          {rows.map((r) => (
            <div key={r.recipeId || r.name} className="sv-glass" style={card}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                    Ordered {r.ordered} · catering {r.catering} · standing {r.standing} · holds {r.holds}
                  </div>
                  {bySiteWords(r.bySite) && <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{bySiteWords(r.bySite)}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 15, fontWeight: 800, ...mono }}>{qtyUnit(r.make, r.unit)}</div>
                  <div style={{ fontSize: 11, color: r.done >= r.make && r.make > 0 ? 'var(--grn)' : 'var(--t3)' }}>{fillWords(r)}</div>
                </div>
              </div>
              {r.ticks.length > 0 && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>{r.ticks.map((t) => tickWords(t)).join(' · ')}</div>}
              {r.make > 0 && r.left > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${r.name} made`} placeholder={String(r.left)} value={tick[r.recipeId] ?? ''}
                    onChange={(e) => setTick((m) => ({ ...m, [r.recipeId]: e.target.value }))} style={{ ...box, width: 100, textAlign: 'right' }} />
                  <button type="button" disabled={busy} onClick={() => doTick(r)} className="sv-glass" style={btn('var(--grn)', !busy)}>Done</button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {tab === 'pick' && (
        <>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10 }}>Amounts sent, lot and use by from the batch. Stock shows as in transit until the site receives it.</div>
          {orders && toPick.length === 0 && <div className="sv-glass" style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>Nothing left to pick today.</div>}
          {toPick.map((o) => {
            const mine = sent[o.po_id] || sentAsOrdered(o);
            const shorts = shortLines(o, mine);
            return (
              <div key={o.po_id} className="sv-glass" style={card}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{o.site_name || 'Site'}{o.reference ? <span style={{ color: 'var(--t3)', fontWeight: 600 }}> · {o.reference}</span> : null}</div>
                {openPo === o.po_id ? (
                  <>
                    {(o.lines || []).map((l) => (
                      <div key={l.po_line_id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{l.name} <span style={{ color: 'var(--t3)', fontSize: 11 }}>ordered {l.qty_packs}</span></div>
                        <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${l.name} sent`} value={mine[l.po_line_id] ?? l.qty_packs}
                          onChange={(e) => setSent((m) => ({ ...m, [o.po_id]: { ...mine, [l.po_line_id]: e.target.value } }))} style={{ ...box, width: 90, textAlign: 'right' }} />
                      </div>
                    ))}
                    {shorts.length > 0 && <div style={{ fontSize: 12, color: 'var(--orn)', marginTop: 8 }}>Short: {shorts.map((x) => `${x.name} ${x.short}`).join(', ')}</div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button type="button" onClick={() => setOpenPo(null)} className="sv-glass" style={btn('var(--t2)')}>Back</button>
                      <button type="button" disabled={busy} onClick={() => doPick(o)} className="sv-glass" style={{ ...btn('var(--grn)', !busy), flex: 1 }}>{busy ? 'Sending…' : 'Send'}</button>
                    </div>
                  </>
                ) : (
                  <button type="button" onClick={() => setOpenPo(o.po_id)} className="sv-glass" style={{ ...btn('var(--grn)'), marginTop: 8 }}>Pick</button>
                )}
              </div>
            );
          })}
          {Object.entries(picked).map(([poId, r]) => (
            <div key={poId} className="sv-glass" style={card}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{r.reference || 'Sent'}</div>
              {(r.note?.lines || []).map((l, i) => (
                <div key={l.po_line_id || i} style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{l.name || 'Item'} {l.sent ?? ''}{lotWords(l) ? ` · ${lotWords(l)}` : ''}</div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>Print the delivery note and labels in Back Office, Central kitchen.</div>
            </div>
          ))}
        </>
      )}
    </SheetFrame>
  );
}
