/**
 * SupplierSitesTab: who can order from this supplier, and each site's own values (mockup
 * scrSupplier Sites, Drop 1 contract 3.4 and 4.3). One row per site in the login's list.
 *
 *   Can order        a tick: stock_save_supplier with only `sites` (on links or brings back that
 *                    site's row; off archives it, never deletes it). Their sites, full control or
 *                    company editors.
 *   Account number,  stock_save_supplier_site, each cell on its own (the link row_version). Any
 *   Order email,     login that reaches the site: the site knows its own account.
 *   CC emails
 *   Min order,       the same save, Their sites, full control or company editors. Grey
 *   Delivery fee     "(company)" when the site follows the company value.
 *   Approval over    company editors only (a manager never raises their own limit); "(none)".
 *
 * Every cell saves when it is left, with the small tick; a refusal or "saved first" shows its
 * words under that row and the row is read again.
 */

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import {
  siteRows, canEditSiteField, sitesTabNote, followValue, siteValueText, siteCommitValue, ccText, savedWords,
} from '../../../../lib/stock/supplierListRules';
import { ui, TableWrap, Th, Td, CellInput, ErrorLine, EmptyLine, useConfirm } from '../stockUi';

const COLS = [
  { key: 'account_number', label: 'Account number', kind: 'text', width: 120 },
  { key: 'email', label: 'Order email', kind: 'text', width: 190 },
  { key: 'cc_emails', label: 'CC emails', kind: 'text', width: 210 },
  { key: 'min_order_value', label: 'Min order', kind: 'number', width: 84 },
  { key: 'delivery_fee', label: 'Delivery fee', kind: 'number', width: 84 },
  { key: 'approval_limit', label: 'Approval over', kind: 'number', width: 84 },
];

const companyValueOf = (s, key) => (key === 'email' ? s?.email ?? null : key === 'min_order_value' ? s?.min_order_value ?? null : key === 'delivery_fee' ? s?.delivery_fee ?? null : null);

export default function SupplierSitesTab({ detail, reload }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [rowError, setRowError] = useState({}); // site id -> words
  const [busy, setBusy] = useState(null); // site id while a tick saves (every tick waits: one version at a time)
  const [confirm, confirmDialog] = useConfirm();
  const s = detail?.supplier || {};
  const rows = useMemo(() => siteRows(sc.sites || [], detail?.sites || []), [sc.sites, detail]);
  const can = useMemo(() => ({ company: sc.canEditCompany('purchasing'), site: sc.canEditSite }), [sc]);
  const local = s.local_location_id || null;
  const note = sitesTabNote({
    company: can.company, level: sc.level,
    siteNames: rows.filter((r) => canEditSiteField('account_number', r.site.id, can)).map((r) => r.site.name),
  });

  const oops = (siteId, words) => setRowError((m) => ({ ...m, [siteId]: words }));
  const clear = (siteId) => setRowError((m) => { if (!m[siteId]) return m; const n = { ...m }; delete n[siteId]; return n; });

  const tick = async (row, on) => {
    const name = row.site.name;
    if (!on) {
      const yes = await confirm({
        title: `Stop ${name} ordering from ${s.name}?`,
        words: `${name} can no longer order from ${s.name}. Its account number and order email are kept, so you can tick it again any time.`,
        yes: 'Stop ordering', no: 'Go back',
      });
      if (!yes) return;
    }
    setBusy(row.site.id); clear(row.site.id);
    const r = await stockApi.saveSupplier({ supplier: { id: s.id }, sites: [{ location_id: row.site.id, on }], version: detail?.row_version ?? null, section: 'purchasing' });
    // the next tick waits for the read after this one, so it carries the new version
    if (r.error) { oops(row.site.id, r.error.message); showToast?.(r.error.message, 'error'); await reload(); setBusy(null); return; }
    showToast?.(savedWords(r.queued, on ? `${name} can now order from ${s.name}.` : `${name} no longer orders from ${s.name}.`), 'success');
    await reload();
    setBusy(null);
  };

  // CellInput shows the words of an { error } answer under the cell, or the saved tick.
  const commit = async (row, key, input) => {
    const link = row.link;
    if (!link) return { error: 'Tick Can order first.' };
    const v = siteCommitValue(key, input, companyValueOf(s, key));
    if (!v.ok) return { error: v.error };
    const r = await stockApi.saveSupplierSite(s.id, row.site.id, { [key]: v.value }, link.link_row_version ?? null);
    await reload();
    return r.error ? { error: r.error.message } : true;
  };

  return (
    <div>
      {confirmDialog}
      {note && (
        <div style={{ ...ui.lockline, marginBottom: 12, lineHeight: 1.45 }}>{note}</div>
      )}
      {rows.length === 0 ? <div style={ui.card}><EmptyLine>No sites to show.</EmptyLine></div> : (
        <TableWrap minWidth={980}>
          <thead>
            <tr>
              <Th>Can order</Th>
              <Th>Site</Th>
              {COLS.map((c) => <Th key={c.key} right={c.kind === 'number'}>{c.label}</Th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const id = row.site.id;
              const link = row.link;
              // a local supplier orders for its own site only: Make it a company supplier first
              const canTick = canEditSiteField('can_order', id, can) && !local;
              return [
                <tr key={id}>
                  <Td>
                    <input type="checkbox" checked={row.on} disabled={!canTick || !!busy}
                      aria-label={`${row.site.name} can order`} onChange={(e) => tick(row, e.target.checked)}
                      style={{ opacity: canTick ? 1 : 0.55 }} />
                  </Td>
                  <Td strong={row.on} grey={!row.on}>{row.site.name}</Td>
                  {!row.on ? (
                    <td colSpan={COLS.length} style={{ ...ui.td, ...ui.grey }}>Cannot order from this supplier</td>
                  ) : COLS.map((c) => {
                    const siteVal = c.key === 'cc_emails' ? ccText(link?.[c.key]) : link?.[c.key] ?? null;
                    const companyVal = companyValueOf(s, c.key);
                    const editable = canEditSiteField(c.key, id, can);
                    const f = c.key === 'account_number' || c.key === 'cc_emails' || c.key === 'approval_limit'
                      ? { value: siteVal, follow: false }
                      : followValue(siteVal, companyVal, c.kind === 'number' ? 'money' : 'text');
                    if (!editable) {
                      const words = siteValueText(c.key, link?.[c.key] ?? null, companyVal, row.site.currency || 'GBP');
                      const grey = words === '(company)' || words === '(none)';
                      return <Td key={c.key} right={c.kind === 'number'} num={c.kind === 'number'} grey={grey}>{words}</Td>;
                    }
                    return (
                      <Td key={c.key} right={c.kind === 'number'} num={c.kind === 'number'}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <CellInput value={c.kind === 'number' ? (f.value ?? null) : (f.value ?? '')} follow={f.follow} width={c.width} kind={c.kind} places={c.kind === 'number' ? 2 : null}
                            ariaLabel={`${c.label} at ${row.site.name}`} onCommit={(v) => commit(row, c.key, v)} />
                          {f.follow && <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>(company)</span>}
                          {c.key === 'approval_limit' && (f.value === null || f.value === '') && <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>(none)</span>}
                        </span>
                      </Td>
                    );
                  })}
                </tr>,
                rowError[id] ? (
                  <tr key={`${id}:error`}>
                    <td colSpan={COLS.length + 2} style={{ ...ui.td, paddingTop: 0 }}><ErrorLine error={new Error(rowError[id])} /></td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </TableWrap>
      )}
      {local && <div style={{ ...ui.sub, marginTop: 10 }}>{`A local supplier orders for ${sc.siteName(local) || 'its own site'} only. Make it a company supplier to let other sites order from it.`}</div>}
    </div>
  );
}
