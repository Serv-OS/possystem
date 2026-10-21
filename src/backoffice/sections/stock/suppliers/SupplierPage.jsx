/**
 * SupplierPage: one supplier of a multi site company (mockup scrSupplier, Drop 1 contract 3.4 and
 * 4.3). One stock_supplier_detail read, reloaded after every save; tabs Details, Sites, Order rules,
 * Items, Changes. A local supplier shows "Local to <site>" and, for company editors, Make it a
 * company supplier (stock_make_company_record).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { SUPPLIER_TABS, tabOrDefault, supplierSubText } from '../../../../lib/stock/supplierListRules';
import { Btn, Pill, PageHead, TabBar, ErrorLine, useConfirm, ui } from '../stockUi';
import SupplierDetailsTab from './SupplierDetailsTab';
import SupplierSitesTab from './SupplierSitesTab';
import SupplierOrderRulesTab from './SupplierOrderRulesTab';
import SupplierItemsTab from './SupplierItemsTab';
import SupplierChangesTab from './SupplierChangesTab';

const TABS = SUPPLIER_TABS.map((t) => ({ id: t.id, label: t.label }));

export default function SupplierPage({ supplierId, startTab = 'sites', onBack }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [tab, setTab] = useState(() => tabOrDefault(startTab));
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const ask = useRef(0);

  // Read the supplier again (after every save); an older answer never replaces a newer one.
  const reload = useCallback(async () => {
    const mine = ++ask.current;
    const r = await stockApi.supplierDetail(supplierId);
    if (mine !== ask.current) return null;
    if (r.error) { setError(r.error); return null; }
    setError(null);
    setDetail(r.data || null);
    return r.data || null;
  }, [supplierId]);

  useEffect(() => {
    const mine = ++ask.current;
    stockApi.supplierDetail(supplierId).then((r) => {
      if (mine !== ask.current) return;
      if (r.error) { setError(r.error); return; }
      setError(null);
      setDetail(r.data || null);
    });
  }, [supplierId]);

  const s = detail?.supplier || null;
  const localId = s?.local_location_id || null;
  const local = !!(detail?.local || localId);
  const editor = sc.canEditCompany('purchasing');

  const makeCompany = async () => {
    const yes = await confirm({
      title: `Make ${s.name} a company supplier?`,
      words: `It stays at ${sc.siteName(localId) || 'its site'}. Head office can then tick other sites on the Sites tab.`,
      yes: 'Make it a company supplier', no: 'Go back',
    });
    if (!yes) return;
    setBusy(true);
    const r = await stockApi.makeCompanyRecord('supplier', supplierId, detail?.row_version ?? null);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); await reload(); return; }
    showToast?.(`${s.name} is now a company supplier.`, 'success');
    await reload();
  };

  const back = (
    <Btn kind="link" small onClick={onBack} style={{ paddingLeft: 0 }}>‹ Suppliers</Btn>
  );

  if (error && !detail) {
    return (
      <div style={ui.page}>
        {back}
        <div style={{ marginTop: 16 }}><ErrorLine error={error} /></div>
      </div>
    );
  }
  if (!detail || !s) {
    return (
      <div style={ui.page}>
        {back}
        <div style={{ padding: '16px 0', color: 'var(--t3)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={ui.page}>
      {confirmDialog}
      <PageHead
        back="‹ Suppliers" onBack={onBack}
        title={<span>{s.name}{local && <Pill tone="blue" style={{ marginLeft: 10, verticalAlign: 'middle' }}>{`Local to ${sc.siteName(localId) || 'one site'}`}</Pill>}{s.archived_at && <Pill style={{ marginLeft: 8, verticalAlign: 'middle' }}>Archived</Pill>}</span>}
        sub={supplierSubText(s)}>
        {local && editor && <Btn onClick={makeCompany} disabled={busy}>Make it a company supplier</Btn>}
      </PageHead>
      {error && <div style={{ margin: '8px 0' }}><ErrorLine error={error} /></div>}

      <TabBar tabs={TABS} value={tab} onChange={(t) => setTab(tabOrDefault(t))} />

      {tab === 'details' && <SupplierDetailsTab key={`${s.id}:${detail.row_version ?? ''}:${s.row_version ?? ''}`} detail={detail} editable={editor || (local && sc.canEditSite(localId, 'site_facts'))} reload={reload} onArchived={onBack} />}
      {tab === 'sites' && <SupplierSitesTab detail={detail} reload={reload} />}
      {tab === 'rules' && <SupplierOrderRulesTab detail={detail} reload={reload} />}
      {tab === 'items' && <SupplierItemsTab detail={detail} reload={reload} />}
      {tab === 'changes' && <SupplierChangesTab supplierId={s.id || supplierId} />}
    </div>
  );
}
