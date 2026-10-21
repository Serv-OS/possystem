// src/backoffice/sections/stock/items/ItemPage.jsx
//
// MULTI SITE STOCK Drop 1 (mockup scrItem): one company stock item. Only a multi site company ever
// sees it (src/backoffice/sections/StockItems.jsx returns today's StockItemsSplit first for a one
// site company, so the one site check company keeps exactly today's screen).
//
//   Header   ‹ Stock items, the name (Local pill on a local item), '<category> · <type> · main
//            supplier <supplier> · <sites text>', Clone, Archive, Make it a company item (a local
//            item, company editors), and '<site> catching up' while queued saves run.
//   Tabs     Details | Packs | Suppliers | Sites | Used in | Changes (itemTabs). It opens on Sites.
//   Data     one stock_item_detail read, read again after every save and on "Keep theirs".
//
// Who may change what: a company editor (Stock control 'All sites' in this company with Inventory,
// or an owner of this company, or ServOS staff), or anyone on their own LOCAL item. Everyone else
// sees the company fields greyed under the lock line ("Set by head office. Ask ... to change it.")
// with Suggest a change, and on the Sites tab only their own sites. The database enforces all of it
// (stock_co__guard and the 0b locks); the screen only greys what it would refuse.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { getLocationConfig } from '../../../../lib/locationTime';
import { ymdInZone } from '../../../../lib/venueDate';
import { sitesText } from '../../../../lib/stock/siteScope';
import { pauseWords } from '../../../../lib/stock/pauseRules';
import { itemTabs, startTabOf, canEditItem, homeSiteOf } from '../../../../lib/stock/itemPageRules';
import { Btn, Pill, PageHead, TabBar, CatchingUp, ErrorLine, useConfirm, ui } from '../stockUi';
import LockLine from '../LockLine';
import ItemDetailsTab from './ItemDetailsTab';
import ItemPacksTab from './ItemPacksTab';
import ItemSuppliersTab from './ItemSuppliersTab';
import ItemSitesTab from './ItemSitesTab';
import ItemUsedInTab from './ItemUsedInTab';
import ItemChangesTab from './ItemChangesTab';
import CloneItemModal from './CloneItemModal';

const TYPE_WORDS = Object.freeze({ food: 'Food', drink: 'Drink', other: 'Other' });
const page = { ...ui.page, background: 'var(--bg0)', minHeight: '100%', boxSizing: 'border-box' };

export default function ItemPage({ itemId, startTab = 'sites', focusSiteId = null, orgCtx, onBack, onOpenItem }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const tabs = useMemo(() => itemTabs(sc.multi), [sc.multi]);
  const [tab, setTab] = useState(() => startTabOf(itemTabs(sc.multi), startTab));
  const [state, setState] = useState({ detail: null, error: null, loading: true });
  const [tz, setTz] = useState(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const seq = useRef(0);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  // the newest read wins: an older answer that lands late is dropped
  const take = useCallback((r, mine) => {
    if (mine !== seq.current) return;
    setState((old) => ({ detail: r.error ? old.detail : r.data, error: r.error || null, loading: false }));
  }, []);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    take(await stockApi.itemDetail(itemId), mine);
  }, [itemId, take]);
  useEffect(() => {
    const mine = ++seq.current;
    stockApi.itemDetail(itemId).then((r) => take(r, mine));
  }, [itemId, take]);

  // a page opened on another item (Clone opens the copy) shows Loading until that item's read lands
  const detail = state.detail && (!itemId || state.detail.item?.id === itemId
    || (state.detail.sites || []).some((s) => s.site_item_id === itemId)) ? state.detail : null;
  const item = detail?.item || null;
  const siteIds = useMemo(() => (sc.sites || []).map((s) => s.id), [sc.sites]);
  const homeSiteId = detail ? homeSiteOf(detail, siteIds, sc.homeSite) : null;
  useEffect(() => {
    if (!homeSiteId) return undefined;
    let live = true;
    getLocationConfig(homeSiteId).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => {});
    return () => { live = false; };
  }, [homeSiteId]);

  if (!detail) {
    return (
      <div style={page}>
        <Btn small onClick={onBack}>‹ Stock items</Btn>
        <div style={{ marginTop: 14 }}>
          {state.loading ? <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div> : <ErrorLine error={state.error} />}
        </div>
      </div>
    );
  }

  const companyEditor = !!sc.canEditCompany('inventory');
  const editable = canEditItem({ companyEditor, item, siteIds });
  const isLocal = !!item.local_location_id || detail.local === true;
  const localName = item.local_location_id ? (sc.siteName(item.local_location_id) || 'its site') : '';
  const mainSi = (detail.supplier_items || []).find((s) => s.id === item.main_supplier_item_id) || null;
  const onIds = (detail.sites || []).filter((s) => s.on_here).map((s) => s.location_id);
  const where = sc.multi ? sitesText({ onIds, scopeIds: siteIds, siteById: sc.siteById, localId: item.local_location_id || null }) : '';
  const sub = [
    item.category_name || item.category || 'No category',
    TYPE_WORDS[item.type] || null,
    mainSi ? `main supplier ${mainSi.supplier_name}` : 'no main supplier yet',
    where || null,
  ].filter(Boolean).join(' · ');
  const today = ymdInZone(new Date(), tz);
  const pausedAll = !!item.paused_from && (!today || (item.paused_from <= today && (!item.paused_until || today <= item.paused_until)));

  const archive = async () => {
    const toArchive = !item.archived_at;
    if (toArchive) {
      const ok = await confirm({ title: `Archive ${item.name}?`, words: 'Only when no site holds it. Archived items keep their history.', yes: 'Archive', no: 'Go back', danger: true });
      if (!ok) return;
    }
    setBusy(true);
    const r = await stockApi.archiveItem(item.id, detail.row_version ?? item.row_version ?? null, toArchive);
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); load(); return; }
    say(toArchive ? `${item.name} archived. Its history is kept.` : `${item.name} is back in the list.`);
    load();
  };
  const makeCompany = async () => {
    const ok = await confirm({ title: `Make ${item.name} a company item?`, words: `It stays at ${localName}. You can then add it to other sites on the Sites tab.`, yes: 'Make it a company item', no: 'Go back' });
    if (!ok) return;
    setBusy(true);
    const r = await stockApi.makeCompanyRecord('item', item.id, detail.row_version ?? item.row_version ?? null);
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); load(); return; }
    say(`${item.name} is now a company item. It stays at ${localName}.`);
    load();
  };

  const showLock = !editable && (tab === 'details' || tab === 'packs' || tab === 'suppliers');
  const common = { detail, editable, reload: load, focusSiteId, orgCtx, homeSiteId, tz };
  const title = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>{item.name}</span>
      {isLocal && <Pill tone="blue" title={localName ? `Local to ${localName}` : undefined}>Local</Pill>}
      {item.archived_at && <Pill tone="neutral">Archived</Pill>}
      {pausedAll && <Pill tone="warn">{pauseWords({ everywhere: true, until: item.paused_until })}</Pill>}
    </span>
  );

  return (
    <div style={page}>
      <PageHead title={title} sub={sub} back="‹ Stock items" onBack={onBack}>
        <CatchingUp entityIds={[item.id]} />
        {companyEditor && <Btn disabled={busy} onClick={() => setCloneOpen(true)}>Clone</Btn>}
        {editable && <Btn disabled={busy} onClick={archive}>{item.archived_at ? 'Restore' : 'Archive'}</Btn>}
        {isLocal && companyEditor && <Btn kind="soft" disabled={busy} onClick={makeCompany}>Make it a company item</Btn>}
      </PageHead>

      <div style={{ marginTop: 14 }}>
        <TabBar tabs={tabs} value={tab} onChange={setTab} />
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        {state.error && <ErrorLine error={state.error} />}
        {showLock && <LockLine kind="company" entity="item" id={item.id} recordName={item.name} />}
        {tab === 'details' && <ItemDetailsTab key={`details:${detail.row_version ?? item.row_version ?? 0}`} {...common} />}
        {tab === 'packs' && <ItemPacksTab {...common} />}
        {tab === 'suppliers' && <ItemSuppliersTab {...common} />}
        {tab === 'sites' && <ItemSitesTab {...common} />}
        {tab === 'usedin' && <ItemUsedInTab {...common} />}
        {tab === 'changes' && <ItemChangesTab {...common} />}
      </div>

      {cloneOpen && (
        <CloneItemModal detail={detail} sites={sc.sites} onClose={() => setCloneOpen(false)}
          onDone={(newId) => { setCloneOpen(false); if (newId && onOpenItem) onOpenItem(newId, { tab: 'sites' }); else load(); }} />
      )}
      {confirmDialog}
    </div>
  );
}
