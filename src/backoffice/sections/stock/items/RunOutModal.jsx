/**
 * Bulk bar > Stop ordering, run out (multi site stock Drop 1): tick the sites. The ticked items can
 * no longer be ordered there; each stays on the counts until it reaches zero, then archives itself
 * (stock_set_item_sites remove, mode 'runout'). Nothing is taken off the shelf and no number moves.
 */

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { itemIdsOf, itemsWords } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, SiteChecklist, ui } from '../stockUi';

export default function RunOutModal({ items, sites, groups = [], onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = itemIdsOf(items);

  const run = async () => {
    if (!chosen.length) { setError('Tick at least one site.'); return; }
    setBusy(true); setError('');
    const r = await stockApi.setItemSites({ items: ids, remove: chosen.map((id) => ({ location_id: id, mode: 'runout' })) });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    const where = chosen.length === 1 ? (sites.find((s) => s.id === chosen[0])?.name || '1 site') : `${chosen.length} sites`;
    try { showToast?.(`Stop ordering, run out at ${where}. It stays on the count until it reaches zero.`, 'success'); } catch { /* no toast, no harm */ }
    onDone?.(r);
  };

  return (
    <Modal title="Stop ordering, run out" sub={itemsWords(items)} onClose={onClose} width={520} dirty={chosen.length > 0}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !chosen.length} onClick={run}>{busy ? 'Saving…' : 'Stop ordering'}</Btn></>}>
      <SiteChecklist sites={sites} value={chosen} onChange={setChosen} groups={groups} />
      <div style={{ ...ui.sub, marginTop: 10 }}>It can no longer be ordered at the ticked sites. It stays on the counts until it reaches zero, then archives itself. Recipes there keep working until then.</div>
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
