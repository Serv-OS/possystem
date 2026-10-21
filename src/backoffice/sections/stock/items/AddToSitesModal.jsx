/**
 * Bulk bar > Add to sites (multi site stock Drop 1, mockup "Add <n> items to sites"): tick the
 * sites; each site gets its row at once with on hand 0 (stock_set_item_sites add). Nothing else
 * moves. Over 200 rows or 5 sites the save queue does it and the bulk bar shows the progress.
 */

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { itemIdsOf } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, SiteChecklist, Notice, ui } from '../stockUi';

export default function AddToSitesModal({ items, sites, groups = [], onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const ids = itemIdsOf(items);
  const n = ids.length;

  const add = async () => {
    if (!chosen.length) { setError('Tick at least one site.'); return; }
    setBusy(true); setError('');
    const r = await stockApi.setItemSites({ items: ids, add: chosen });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    const k = chosen.length;
    const left = r.data?.refused || [];
    const added = r.data?.added != null ? Number(r.data.added) > 0 : !left.length;
    if (added) { try { showToast?.(`Added to ${k} ${k === 1 ? 'site' : 'sites'}. On hand starts at 0.`, 'success'); } catch { /* no toast, no harm */ } }
    if (left.length) { setResult(r); return; }
    onDone?.(r);
  };

  const refused = result?.data?.refused || [];
  const footer = result
    ? <><span style={{ flex: 1 }} /><Btn kind="primary" onClick={() => onDone?.(result)}>Close</Btn></>
    : <><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !chosen.length} onClick={add}>{busy ? 'Adding…' : 'Add'}</Btn></>;

  return (
    <Modal title={`Add ${n} ${n === 1 ? 'item' : 'items'} to sites`} onClose={result ? () => onDone?.(result) : onClose} width={520} dirty={chosen.length > 0 && !result} footer={footer}>
      {result ? (
        <Notice tone="warn">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>These were not added:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{refused.slice(0, 20).map((x, i) => <li key={i}>{x.error}</li>)}</ul>
        </Notice>
      ) : (
        <>
          <SiteChecklist sites={sites} value={chosen} onChange={setChosen} groups={groups} />
          <div style={{ ...ui.sub, marginTop: 10 }}>Each site gets its row at once, on hand 0. Nothing else moves.</div>
          {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
        </>
      )}
    </Modal>
  );
}
