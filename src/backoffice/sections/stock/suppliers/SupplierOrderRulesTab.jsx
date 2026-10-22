/**
 * SupplierOrderRulesTab: when each site gets deliveries from this supplier (mockup scrSupplier
 * Order rules, Drop 1 contract 3.4 and 4.3). Rows are the sites in the login's list that can order;
 * columns Monday to Sunday. A cell says "✓ Delivery" and "order by Sun 14:00", or "·" for no
 * delivery that day.
 *
 * Company editors press a cell to change that day (Delivery tick, Order by day and time, or No
 * order by time); the save sends that site's whole set (stock_save_order_rules, the link
 * row_version), and the database writes the site's delivery days and cut off from it in the same
 * save, so the Order pad and every reader today keep working. "Copy <site>'s rules to all sites"
 * copies one site's set to every other site that can order (stock_copy_order_rules).
 */

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import {
  WEEK_COLUMNS, dayLabel, dayName, cellModel, ruleFor, withDay, validRules, sameRules, defaultOrderBy, deriveDays, copyTargets, timeText,
} from '../../../../lib/stock/orderRules';
import { siteRows } from '../../../../lib/stock/supplierListRules';
import { Btn, Popover, Notice, ui, TableWrap, Th, Td, ErrorLine, EmptyLine, useConfirm } from '../stockUi';
import LockLine from '../LockLine';
import StandingOrdersPanel from './StandingOrdersPanel';
import DeliveryExceptionsPanel from './DeliveryExceptionsPanel';

function CellView({ rules, dow }) {
  const c = cellModel(rules, dow);
  if (!c.delivery) return <span style={{ color: 'var(--t4)' }}>·</span>;
  return (
    <span style={{ display: 'block', fontSize: 12, lineHeight: 1.3, textAlign: 'left' }}>
      <b style={{ display: 'block', color: 'var(--acc)', fontWeight: 700 }}>✓ Delivery</b>
      {c.orderBy && <span style={{ color: 'var(--t2)', fontWeight: 400 }}>{c.orderBy}</span>}
    </span>
  );
}

function RuleEditor({ supplier, row, dow, close, reload }) {
  const showToast = useStore((s) => s.showToast);
  const rules = row.link?.rules || [];
  const now = ruleFor(rules, dow);
  const cutoff = deriveDays(rules).cutoff_time || timeText(row.link?.cutoff_time);
  const start = now
    ? { order_by_dow: now.order_by_dow, order_by_time: timeText(now.order_by_time) }
    : defaultOrderBy(dow, cutoff);
  // Pressing a day is asking for a delivery there, so the tick starts on (untick to take it off).
  const [delivery, setDelivery] = useState(true);
  const [noOrderBy, setNoOrderBy] = useState(start.order_by_dow === null || start.order_by_dow === undefined);
  const [orderDow, setOrderDow] = useState(start.order_by_dow ?? (dow + 6) % 7);
  const [time, setTime] = useState(start.order_by_time || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    const next = withDay(rules, dow, delivery ? { order_by_dow: noOrderBy ? null : orderDow, order_by_time: noOrderBy ? null : time || null } : null);
    const checked = validRules(next);
    if (!checked.ok) { setError(new Error(checked.error)); return; }
    // nothing changed (for example no delivery on a day that had none): no save and no toast
    if (sameRules(checked.rules, rules)) { close(); return; }
    setBusy(true); setError(null);
    const r = await stockApi.saveOrderRules(supplier.id, row.site.id, checked.rules, row.link?.link_row_version ?? null);
    setBusy(false);
    if (r.error) { setError(r.error); await reload(); return; }
    showToast?.(`Order rules saved for ${row.site.name}.`, 'success');
    close();
    await reload();
  };

  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
      <div style={{ fontWeight: 800 }}>{`${row.site.name}, ${dayName(dow)}`}</div>
      <label style={{ ...ui.row, cursor: 'pointer' }}>
        <input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} />
        <span>{`Delivery on ${dayName(dow)}`}</span>
      </label>
      {delivery && (
        <>
          <div>
            <span style={ui.label}>Order by</span>
            <div style={{ ...ui.row, opacity: noOrderBy ? 0.55 : 1 }}>
              <select value={orderDow} disabled={noOrderBy} onChange={(e) => setOrderDow(Number(e.target.value))} aria-label="Order by day" style={{ ...ui.input, width: 96 }}>
                {WEEK_COLUMNS.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
              </select>
              <input type="time" value={time} disabled={noOrderBy} onChange={(e) => setTime(e.target.value)} aria-label="Order by time" style={{ ...ui.input, width: 120 }} />
            </div>
          </div>
          <label style={{ ...ui.row, cursor: 'pointer' }}>
            <input type="checkbox" checked={noOrderBy} onChange={(e) => setNoOrderBy(e.target.checked)} />
            <span>No order by time</span>
          </label>
        </>
      )}
      {error && <ErrorLine error={error} />}
      <div style={{ ...ui.row, justifyContent: 'flex-end' }}>
        <Btn small onClick={close} disabled={busy}>Cancel</Btn>
        <Btn small kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
      </div>
    </div>
  );
}

export default function SupplierOrderRulesTab({ detail, reload }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [confirm, confirmDialog] = useConfirm();
  const s = detail?.supplier || {};
  const editor = sc.canEditCompany('purchasing');
  const rows = useMemo(() => siteRows(sc.sites || [], detail?.sites || []).filter((r) => r.on), [sc.sites, detail]);
  const [fromId, setFromId] = useState(null);
  const [copying, setCopying] = useState(false);
  const [skipped, setSkipped] = useState([]);
  const [exceptions, setExceptions] = useState(false); // v5.11.96 (Drop 3): the Exceptions and holidays panel
  const from = rows.find((r) => r.site.id === fromId) || rows.find((r) => (r.link?.rules || []).length) || rows[0] || null;

  const copy = async () => {
    if (!from) return;
    const to = copyTargets(detail?.sites || [], from.site.id).filter((id) => rows.some((r) => r.site.id === id));
    if (!to.length) return;
    const yes = await confirm({
      title: `Copy ${from.site.name}'s rules to all sites?`,
      words: `The delivery days and order by times at the other ${to.length === 1 ? 'site' : `${to.length} sites`} that can order from ${s.name} are replaced by ${from.site.name}'s.`,
      yes: 'Copy', no: 'Go back',
    });
    if (!yes) return;
    setCopying(true); setSkipped([]);
    const r = await stockApi.copyOrderRules(s.id, from.site.id, to);
    setCopying(false);
    if (r.error) { showToast?.(r.error.message, 'error'); await reload(); return; }
    showToast?.(`Copied. ${from.site.name}'s delivery days and order by times are now on every site that can order from ${s.name}.`, 'success');
    setSkipped(r.data?.skipped || []);
    await reload();
  };

  return (
    <div>
      {confirmDialog}
      <div style={{ marginBottom: 12 }}><Notice tone="info"><b>When each site gets deliveries.</b> One source for the Order pad's dates, the order by reminders, approval cut offs and the order email.</Notice></div>
      {!editor && <div style={{ marginBottom: 12 }}><LockLine entity="supplier" id={s.id} recordName={s.name} kind="company" /></div>}
      <div style={{ ...ui.row, marginBottom: 12 }}><Btn small onClick={() => setExceptions(true)}>Exceptions and holidays</Btn></div>
      {editor && rows.length > 1 && (
        <div style={{ ...ui.row, flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={from?.site.id || ''} onChange={(e) => setFromId(e.target.value)} aria-label="Site to copy from" style={{ ...ui.input, width: 220 }}>
            {rows.map((r) => <option key={r.site.id} value={r.site.id}>{r.site.name}</option>)}
          </select>
          <Btn small onClick={copy} disabled={copying || !from}>{copying ? 'Copying…' : `Copy ${from?.site.name || ''}'s rules to all sites`}</Btn>
        </div>
      )}
      {skipped.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="warn" onClose={() => setSkipped([])}>
            {skipped.map((k) => `${sc.siteName(k.location_id) || 'A site'}: ${k.reason}`).join(' ')}
          </Notice>
        </div>
      )}
      {rows.length === 0 ? (
        <div style={ui.card}><EmptyLine>No site can order from this supplier yet. Tick the sites on the Sites tab first.</EmptyLine></div>
      ) : (
        <TableWrap minWidth={860}>
          <thead>
            <tr>
              <Th>Site</Th>
              {WEEK_COLUMNS.map((d) => <Th key={d}>{dayLabel(d)}</Th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rules = row.link?.rules || [];
              return (
                <tr key={row.site.id}>
                  <Td strong>{row.site.name}</Td>
                  {WEEK_COLUMNS.map((d) => (
                    <Td key={d}>
                      {editor ? (
                        <Popover width={300} ariaLabel={`${row.site.name} ${dayName(d)}`}
                          btnStyle={{ border: '1px solid transparent', background: 'transparent', padding: '4px 6px', whiteSpace: 'normal', textAlign: 'left', fontWeight: 400, minWidth: 92, minHeight: 34 }}
                          label={<CellView rules={rules} dow={d} />}>
                          {(close) => <RuleEditor supplier={s} row={row} dow={d} close={close} reload={reload} />}
                        </Popover>
                      ) : <CellView rules={rules} dow={d} />}
                    </Td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      {editor && rows.length > 0 && <div style={{ ...ui.sub, marginTop: 10 }}>Press a day to set a delivery and its order by time.</div>}
      <StandingOrdersPanel detail={detail} reload={reload} />
      {exceptions && <DeliveryExceptionsPanel orgId={sc.orgId} supplier={s} onClose={() => setExceptions(false)} />}
    </div>
  );
}
