/**
 * Bulk bar > Change category (multi site stock Drop 1): pick one category from the company list
 * (stock_co_categories) for every ticked item. One stock_save_item per item with the version its
 * row was read at, at most 4 at a time; an item someone changed meanwhile is told, never overwritten.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { bulkOutcome, itemsWords, runLimited } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, Field, ErrorLine, ui } from '../stockUi';

export default function ChangeCategoryModal({ items, orgId, onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [cats, setCats] = useState(null);
  const [readError, setReadError] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    stockApi.categories(orgId).then((r) => {
      if (!live) return;
      if (r.error) setReadError(r.error); else setCats((r.data || []).filter((c) => !c.archived_at));
    });
    return () => { live = false; };
  }, [orgId]);

  const run = async () => {
    if (!pick) { setError('Pick a category.'); return; }
    const list = items || [];
    setBusy(true); setError('');
    const results = await runLimited(list.map((it) => () => stockApi.saveItem({
      item: { id: it.id, ...(it.local_location_id ? { location_id: it.local_location_id } : {}), category_id: pick },
      version: it.row_version ?? null,
    })), 4);
    setBusy(false);
    const out = bulkOutcome(results);
    const name = cats?.find((c) => c.id === pick)?.name || 'the category';
    if (out.failed) {
      setError(out.ok ? `${out.ok} changed. ${out.failed} did not change: ${out.first}` : out.first);
      if (!out.ok) return;
    }
    try { showToast?.(list.length === 1 ? `${list[0].name} is now in ${name}.` : `${out.ok} items are now in ${name}.`, out.failed ? 'warning' : 'success'); } catch { /* no toast, no harm */ }
    if (!out.failed) onDone?.({ queued: results.flatMap((r) => r?.value?.queued || []) });
  };

  return (
    <Modal title="Change category" sub={itemsWords(items)} onClose={onClose} width={480} dirty={!!pick && !busy}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !pick} onClick={run}>{busy ? 'Saving…' : 'Change'}</Btn></>}>
      {readError ? <ErrorLine error={readError} /> : (
        <Field label="Category">
          <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!cats} aria-label="Category" style={ui.input}>
            <option value="">{cats ? 'Pick a category' : 'Loading…'}</option>
            {(cats || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      {error && <div style={{ ...ui.err, marginTop: 6 }}>{error}</div>}
    </Modal>
  );
}
