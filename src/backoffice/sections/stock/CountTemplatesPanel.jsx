// src/backoffice/sections/stock/CountTemplatesPanel.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map I2): company count templates. Head
// office sets the list of company items once and the sites (or site groups) it is for; each site
// keeps its own shelf order (ShelfOrderEditor). A count is started from a template on Stock counts
// ('From a template'). Saves go through stock_save_count_template.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { moveItem } from '../../../lib/stock/countPlanRules';
import { useStockScope } from '../../StockScope';
import { Btn, Field, Sheet, SiteChecklist, ui, ErrorLine, EmptyLine, useConfirm } from './stockUi';
import ShelfOrderEditor from './ShelfOrderEditor';

function ItemSearch({ orgId, onPick, taken }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  useEffect(() => {
    let live = true;
    const text = q.trim();
    if (!text || !orgId) return () => { live = false; };
    const t = setTimeout(() => {
      stockApi.itemsPage({ orgId, search: text, limit: 20 }).then((r) => { if (live) setHits(r.data?.rows || []); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, orgId]);
  const shown = q.trim() ? hits.filter((h) => !taken.has(h.id)) : [];
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a company item..." style={ui.input} />
      {shown.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
          {shown.map((h) => <div key={h.id} onClick={() => { onPick({ id: h.id, name: h.name }); setQ(''); }} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>{h.name}</div>)}
        </div>
      )}
    </div>
  );
}

export default function CountTemplatesPanel({ orgCtx = null }) {
  const sc = useStockScope();
  const orgId = sc.orgId || orgCtx?.orgId || null;
  const showToast = useStore((s) => s.showToast);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);   // { id, name, items: [{ id, name }], sites: [], groups: [], row_version }
  const [busy, setBusy] = useState(false);
  const [shelf, setShelf] = useState(null);   // { templateId, siteId }
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await stockApi.countTemplates(orgId);
    if (r.error) { setError(r.error); setList([]); return; }
    setError(null); setList(r.data || []);
  }, [orgId]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const open = async (t) => {
    if (!t) { setDraft({ id: null, name: '', items: [], sites: [], groups: [], row_version: null }); return; }
    const lines = [...(t.stock_count_template_lines || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    // the names of the company items on it: stock_items_page takes at most 100 ids a call (2,000 items at most)
    const ids = lines.map((l) => l.item_id);
    const names = {};
    for (let i = 0; i < ids.length && i < 2000; i += 100) {
      const r = await stockApi.itemsPage({ orgId, filters: { ids: ids.slice(i, i + 100) }, limit: 100 });
      if (r.error) break;
      (r.data?.rows || []).forEach((row) => { names[row.id] = row.name; });
    }
    const sitesRows = t.stock_count_template_sites || [];
    setDraft({ id: t.id, name: t.name, row_version: t.row_version ?? null,
      items: ids.map((id) => ({ id, name: names[id] || 'Company item' })),
      sites: sitesRows.filter((s) => s.location_id).map((s) => s.location_id),
      groups: sitesRows.filter((s) => s.group_id).map((s) => s.group_id) });
  };

  const save = async (archived = false) => {
    if (!archived && !draft.name.trim()) { showToast?.('Give the template a name.', 'error'); return; }
    if (!archived && !draft.items.length) { showToast?.('Add at least one item.', 'error'); return; }
    setBusy(true);
    const tpl = { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), ...(archived ? { archived: true } : {}) };
    const lines = draft.items.map((x, i) => ({ item_id: x.id, sort_order: i }));
    const sites = [...draft.sites.map((id) => ({ location_id: id })), ...draft.groups.map((id) => ({ group_id: id }))];
    const r = await stockApi.saveCountTemplate(tpl, lines, sites, draft.row_version);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.(archived ? 'Template archived.' : 'Template saved.', 'success');
    setDraft(null);
    await load();
  };
  const archive = async () => {
    const yes = await confirm({ title: 'Archive this template?', words: 'Counts already started from it stay as they are.', yes: 'Archive', danger: true });
    if (yes) await save(true);
  };

  const taken = new Set((draft?.items || []).map((x) => x.id));
  return (
    <div>
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ ...ui.sub, flex: 1 }}>The company sets the list once. Each site drags items into its own shelf order.</div>
        <Btn kind="primary" onClick={() => open(null)}>New template</Btn>
      </div>
      <ErrorLine error={error} />
      {list === null && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
      {list && list.length === 0 && !error && <EmptyLine>No count templates yet.</EmptyLine>}
      {(list || []).map((t) => {
        const n = (t.stock_count_template_lines || []).length;
        const siteIds = (t.stock_count_template_sites || []).filter((s) => s.location_id).map((s) => s.location_id);
        return (
          <div key={t.id} style={{ ...ui.card, padding: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{t.name}</div>
              <div style={{ ...ui.sub, marginTop: 3 }}>{n} item{n === 1 ? '' : 's'}</div>
            </div>
            {siteIds.length > 0 && (
              <select defaultValue="" onChange={(e) => { if (e.target.value) setShelf({ templateId: t.id, siteId: e.target.value }); e.target.value = ''; }} style={{ ...ui.input, width: 'auto' }} aria-label="Shelf order at a site">
                <option value="">Shelf order at...</option>
                {siteIds.map((id) => <option key={id} value={id}>{sc.siteName(id) || 'Site'}</option>)}
              </select>
            )}
            <Btn small onClick={() => open(t)}>Edit</Btn>
          </div>
        );
      })}
      {draft && (
        <Sheet title={draft.id ? 'Count template' : 'New count template'} width={620} onClose={() => setDraft(null)}
          footer={<>
            {draft.id && <Btn kind="danger" onClick={archive} disabled={busy}>Archive</Btn>}
            <Btn onClick={() => setDraft(null)} disabled={busy} style={{ marginLeft: 'auto' }}>Cancel</Btn>
            <Btn kind="primary" onClick={() => save(false)} disabled={busy}>{busy ? 'Saving...' : 'Save'}</Btn>
          </>}>
          <Field label="Name"><input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} style={ui.input} placeholder="Bar and cellar" /></Field>
          <Field label={`Items (${draft.items.length})`} hint="The company order. Each site can change its own shelf order.">
            <ItemSearch orgId={orgId} taken={taken} onPick={(it) => setDraft((d) => ({ ...d, items: [...d.items, it] }))} />
            <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
              {draft.items.map((x, i) => (
                <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 4px', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>
                  <span style={{ flex: 1 }}>{x.name}</span>
                  <Btn small kind="soft" disabled={i === 0} onClick={() => setDraft((d) => ({ ...d, items: moveItem(d.items, i, i - 1) }))}>Up</Btn>
                  <Btn small kind="soft" disabled={i === draft.items.length - 1} onClick={() => setDraft((d) => ({ ...d, items: moveItem(d.items, i, i + 1) }))}>Down</Btn>
                  <Btn small kind="link" onClick={() => setDraft((d) => ({ ...d, items: d.items.filter((y) => y.id !== x.id) }))}>Remove</Btn>
                </div>
              ))}
            </div>
          </Field>
          <Field label="Sites">
            <SiteChecklist sites={sc.sites || []} groups={sc.groups || []} value={draft.sites} onChange={(ids) => setDraft((d) => ({ ...d, sites: ids || [] }))} />
          </Field>
        </Sheet>
      )}
      {shelf && <ShelfOrderEditor templateId={shelf.templateId} siteId={shelf.siteId} onClose={() => setShelf(null)} />}
    </div>
  );
}
