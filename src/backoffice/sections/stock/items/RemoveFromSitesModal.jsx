/**
 * Bulk bar > Remove from sites (multi site stock Drop 1): for each site, one of the two choices.
 *  - Stop ordering, run out: never ordered there again; it stays on the counts until it reaches
 *    zero, then archives itself.
 *  - Remove now: only where the site holds none and no recipe there uses it. The database checks
 *    each pair and lists what it did not remove, in its own words.
 * Unticked rows are archived, never deleted (stock_set_item_sites remove).
 */

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { itemIdsOf } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, Segmented, Notice, ui } from '../stockUi';

const CHOICES = [
  { value: '', label: 'Leave' },
  { value: 'runout', label: 'Stop ordering, run out' },
  { value: 'remove', label: 'Remove now' },
];

export default function RemoveFromSitesModal({ items, sites, onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const ids = itemIdsOf(items);
  const n = ids.length;
  const remove = Object.entries(pick).filter(([, how]) => how).map(([location_id, how]) => ({ location_id, mode: how }));

  const run = async () => {
    if (!remove.length) { setError('Choose Stop ordering, run out or Remove now for at least one site.'); return; }
    setBusy(true); setError('');
    const r = await stockApi.setItemSites({ items: ids, remove });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    const refused = r.data?.refused || [];
    const done = Number(r.data?.run_out || 0) + Number(r.data?.removed || 0);
    if (done) { try { showToast?.(`Done at ${remove.length} ${remove.length === 1 ? 'site' : 'sites'}. Unticked rows are archived, never deleted.`, 'success'); } catch { /* no toast, no harm */ } }
    if (refused.length) { setResult(r); return; }
    onDone?.(r);
  };

  if (result) {
    return (
      <Modal title={`Remove ${n} ${n === 1 ? 'item' : 'items'} from sites`} onClose={() => onDone?.(result)} width={560}
        footer={<><span style={{ flex: 1 }} /><Btn kind="primary" onClick={() => onDone?.(result)}>Close</Btn></>}>
        <Notice tone="warn">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>These were not removed:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>
            {(result.data?.refused || []).slice(0, 30).map((x, i) => <li key={i}>{x.error}</li>)}
          </ul>
          {(result.data?.refused || []).length > 30 && <div style={{ marginTop: 4 }}>And {(result.data.refused.length - 30)} more.</div>}
        </Notice>
      </Modal>
    );
  }

  return (
    <Modal title={`Remove ${n} ${n === 1 ? 'item' : 'items'} from sites`} onClose={onClose} width={640} dirty={remove.length > 0}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="danger" disabled={busy || !remove.length} onClick={run}>{busy ? 'Working…' : 'Remove'}</Btn></>}>
      <div style={{ display: 'grid', gap: 6 }}>
        {sites.map((s) => (
          <div key={s.id} style={{ ...ui.row, justifyContent: 'space-between', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{s.name}</span>
            <Segmented small value={pick[s.id] || ''} options={CHOICES} onChange={(v) => setPick((p) => ({ ...p, [s.id]: v }))} />
          </div>
        ))}
      </div>
      <div style={{ ...ui.sub, marginTop: 10 }}>
        Stop ordering, run out: it can no longer be ordered there. It stays on the counts until it reaches zero, then archives itself.
        Remove now: only where nothing is held and no recipe there uses it. Unticked rows are archived, never deleted.
      </div>
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
