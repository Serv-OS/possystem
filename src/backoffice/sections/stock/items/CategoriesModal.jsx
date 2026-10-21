/**
 * Stock items > Categories (multi site stock Drop 1): one category list for every site. Each
 * category can carry an accounting code and a GP target. Each box saves when you leave it
 * (stock_save_category with the version it was read at); a new name is written onto every item in
 * it. Archive is refused while live items use the category, in the database's words.
 *
 * Also opened from the item page's Category box ('+ New category').
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { pctInput, runLimited } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, TableWrap, Th, Td, CellInput, ErrorLine, EmptyLine, useConfirm, ui } from '../stockUi';

export default function CategoriesModal({ orgId, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((w, t = 'success') => { try { showToast?.(w, t); } catch { /* no toast, no harm */ } }, [showToast]);
  const [confirm, confirmDialog] = useConfirm();
  const [list, setList] = useState(null);
  const [readError, setReadError] = useState(null);
  const [tick, setTick] = useState(0);
  const [counts, setCounts] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    stockApi.categories(orgId, { archived: true }).then(async (r) => {
      if (!live) return;
      if (r.error) { setReadError(r.error); return; }
      const rows = r.data || [];
      setReadError(null);
      setList(rows);
      // How many live items sit in each live category (one small read each, 4 at a time).
      const live2 = rows.filter((c) => !c.archived_at);
      const res = await runLimited(live2.map((c) => () => stockApi.itemsPage({ orgId, sites: null, search: null, filters: { category_id: c.id }, after: null, limit: 1 })), 4);
      if (!live) return;
      const out = {};
      live2.forEach((c, i) => { const t = res[i]?.value?.data?.total; if (t != null) out[c.id] = Number(t); });
      setCounts(out);
    });
    return () => { live = false; };
  }, [orgId, tick]);

  const reload = () => setTick((t) => t + 1);

  // Each box answers itself: the database's words go under the box (CellInput), and a version
  // someone else moved on reloads the list.
  const save = async (cat, patch, words) => {
    const r = await stockApi.saveCategory({ id: cat.id, ...patch }, cat.row_version ?? null);
    if (r.error) { if (r.conflict) reload(); return { error: r.error.message }; }
    toast(words);
    if (r.queued?.length) toast(`Saved. Every item in ${patch.name || cat.name} catches up within a minute.`, 'info');
    reload();
    return null;
  };
  const rename = (cat, v) => {
    const next = String(v ?? '').trim();
    if (!next) return { error: 'A category needs a name.' };
    if (next === cat.name) return null;
    return save(cat, { name: next }, `Renamed to ${next}. Every item in it now says ${next}.`);
  };
  const setCode = (cat, v) => {
    const next = String(v ?? '').trim() || null;
    if (next === (cat.accounting_code || null)) return null;
    return save(cat, { accounting_code: next }, `Accounting code saved for ${cat.name}.`);
  };
  const setGp = (cat, v) => {
    const next = pctInput(v);
    if (Number.isNaN(next)) return { error: 'A GP target is a percent from 0 to 100.' };
    if (next === (cat.gp_target_pct == null ? null : Number(cat.gp_target_pct))) return null;
    return save(cat, { gp_target_pct: next }, `GP target saved for ${cat.name}.`);
  };
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const r = await stockApi.saveCategory({ org_id: orgId, name: n }, null);
    setBusy(false);
    if (r.error) { toast(r.error.message, 'error'); return; }
    setName('');
    toast(`${n} added.`);
    reload();
  };
  const archive = async (cat, archived) => {
    if (archived) {
      const ok = await confirm({ title: `Archive ${cat.name}?`, words: 'Items keep their history. Only a category with no live items can be archived.', yes: 'Archive', danger: true });
      if (!ok) return;
    }
    const r = await stockApi.archiveCategory(cat.id, cat.row_version ?? null, archived);
    if (r.error) { toast(r.error.message, 'error'); reload(); return; }
    toast(archived ? `${cat.name} archived.` : `${cat.name} is back.`, 'info');
    reload();
  };

  const shown = (list || []).filter((c) => showArchived || !c.archived_at);

  return (
    <Modal title="Categories" sub="One list for every site. Each category can carry an accounting code and a GP target." onClose={onClose} width={760}
      footer={<>
        <label style={{ ...ui.row, fontSize: 12.5, color: 'var(--t3)' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <span style={{ flex: 1 }} />
        <Btn kind="primary" onClick={onClose}>Done</Btn>
      </>}>
      {confirmDialog}
      {readError ? <ErrorLine error={readError} /> : !list ? <EmptyLine>Loading…</EmptyLine> : (
        <>
          <div>
            {!shown.length ? <EmptyLine>No categories yet. Add the first one below.</EmptyLine> : (
              <TableWrap minWidth={620}>
                <thead><tr><Th>Category</Th><Th>Accounting code</Th><Th right>GP target</Th><Th right>Items</Th><Th /></tr></thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.id}>
                      <Td>{c.archived_at ? <span style={{ color: 'var(--t4)' }}>{c.name}</span> : <CellInput kind="text" width={200} value={c.name} ariaLabel={`Name of ${c.name}`} onCommit={(v) => rename(c, v)} />}</Td>
                      <Td>{c.archived_at ? (c.accounting_code || '') : <CellInput kind="text" width={130} value={c.accounting_code || ''} ariaLabel={`Accounting code of ${c.name}`} onCommit={(v) => setCode(c, v)} />}</Td>
                      <Td right>{c.archived_at ? (c.gp_target_pct != null ? `${Number(c.gp_target_pct)}%` : '') : <CellInput width={76} value={c.gp_target_pct ?? ''} ariaLabel={`GP target of ${c.name}`} onCommit={(v) => setGp(c, v)} />}</Td>
                      <Td right num>{c.archived_at ? '' : counts[c.id] ?? ''}</Td>
                      <Td right>
                        {c.archived_at
                          ? <Btn small onClick={() => archive(c, false)}>Bring back</Btn>
                          : <Btn small kind="danger" onClick={() => archive(c, true)}>Archive</Btn>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </div>
          <div style={{ ...ui.row, marginTop: 12, flexWrap: 'wrap' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              placeholder="New category name" aria-label="New category name" style={{ ...ui.input, width: 260 }} />
            <Btn disabled={busy || !name.trim()} onClick={add}>+ Add a category</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}
