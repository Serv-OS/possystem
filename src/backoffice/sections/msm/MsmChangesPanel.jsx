// src/backoffice/sections/msm/MsmChangesPanel.jsx
//
// MULTI SITE MENU (v5.11.75): the draft's staged changes in words, grouped by product. Take one
// back, rename the draft or throw it away. Publishing (now or at a time) is its own tab, with the
// per site preview and the health check, when that tab is present.

import { useMemo, useState } from 'react';
import { groupChanges, unstageOrder } from '../../../lib/msm/msmWords';
import { Btn, Sheet, Notice } from './msmUi';
import { ui } from './msmStyle';
import { useConfirm } from './useConfirm';

export default function MsmChangesPanel({ api, eff, sites, working, rows, unstage, editable, refreshSets, setWorkingId, setNote, setTab, tabIds = [], onClose }) {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const names = useMemo(() => ({
    products: new Map((eff?.products || []).map((p) => [p.id, p.menu_name || p.name])),
    categories: new Map((eff?.categories || []).map((c) => [c.id, c.label])),
    sites: new Map(sites.map((s) => [s.id, s.name])),
  }), [eff, sites]);
  const groups = useMemo(() => groupChanges(rows, names), [rows, names]);

  // Taking back a new product takes back its sites too; a new category still used by a staged
  // product stays until that product is moved or taken back (msmWords.unstageOrder).
  const undoRow = async (row) => {
    const plan = unstageOrder(rows, row);
    if (plan.words) { setNote({ tone: 'warn', text: plan.words }); return; }
    setBusy(true);
    for (const r of plan.rows) {
      const res = await unstage(r);
      if (!res?.ok) break;
    }
    setBusy(false);
  };

  const discard = async () => {
    if (!working || working.status !== 'draft') return;
    const yes = await confirm({ title: `Throw away "${working.title}"?`, words: `Its ${rows.length} change${rows.length === 1 ? '' : 's'} go. The tills are not affected.`, yes: 'Throw it away', no: 'Keep it', danger: true });
    if (!yes) return;
    setBusy(true);
    const r = await api.discardDraft(working.id);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setWorkingId(null);
    await refreshSets();
    setNote({ tone: 'good', text: `"${working.title}" was thrown away. Nothing changed at any site.` });
    onClose();
  };

  return (
    <Sheet title={working ? working.title : 'Changes'} width={560} onClose={onClose}
      sub={working ? `${rows.length} change${rows.length === 1 ? '' : 's'}, not on the tills yet.` : 'No draft yet: your first change makes one.'}
      footer={(
        <>
          {tabIds.includes('publish') && working?.status === 'draft' && rows.length > 0 && (
            <Btn kind="primary" onClick={() => { onClose(); setTab('publish'); }}>Publish or schedule…</Btn>
          )}
          <div style={{ flex: 1 }} />
          {editable && working?.status === 'draft' && <Btn kind="danger" disabled={busy} onClick={discard}>Throw the draft away</Btn>}
        </>
      )}>
      {confirmDialog}
      {!rows.length && <Notice>Nothing staged. Change a price, turn a product on or off, or add a product, and it shows here.</Notice>}
      {groups.map((g) => (
        <div key={g.key} style={{ padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 750, marginBottom: 4 }}>{g.subject}</div>
          {g.lines.map(({ row, words }) => (
            <div key={row.id || `${row.target}${row.location_id}`} style={{ ...ui.row, fontSize: 12.5, color: 'var(--t2)', padding: '2px 0' }}>
              <span style={{ flex: 1 }}>{words}</span>
              {editable && working?.status === 'draft' && row.id && <Btn small kind="link" disabled={busy} onClick={() => undoRow(row)}>Undo</Btn>}
            </div>
          ))}
        </div>
      ))}
    </Sheet>
  );
}
