// src/backoffice/sections/msm/MsmChangesPanel.jsx
//
// MULTI SITE MENU (v5.11.75): the draft's changes in words, grouped by product (and, from round 2,
// by option group). Take one out of the draft, or throw the whole draft away. Publishing (now or at
// a time) is the Review and publish tab, with the per site preview and the health check.

import { useMemo, useState } from 'react';
import { groupChanges, unstageOrder, changeWords } from '../../../lib/msm/msmWords';
import { Btn, Sheet, Notice } from './msmUi';
import { ui } from './msmStyle';
import { useConfirm } from './useConfirm';

export default function MsmChangesPanel({ api, eff, sites, working, rows, unstage, stage, editable, refreshSets, setWorkingId, setNote, setTab, tabIds = [], onClose }) {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const names = useMemo(() => ({
    products: new Map((eff?.products || []).map((p) => [p.id, p.menu_name || p.name])),
    categories: new Map((eff?.categories || []).map((c) => [c.id, c.label])),
    sites: new Map(sites.map((s) => [s.id, s.name])),
    groups: new Map((eff?.groups || []).map((g) => [g.id, g.name])),
    options: new Map((eff?.options || []).map((o) => [o.id, o.name])),
    optionGroup: new Map((eff?.options || []).map((o) => [o.id, o.group_id])),
  }), [eff, sites]);
  const groups = useMemo(() => groupChanges(rows, names), [rows, names]);

  // Taking back a new product takes back its sites too; a new category still used by a staged
  // product stays until that product is moved or taken back (msmWords.unstageOrder).
  const undoRow = async (row) => {
    const plan = unstageOrder(rows, row, names);
    if (plan.words) { setNote({ tone: 'warn', text: plan.words }); return; }
    setBusy(true);
    const out = [];
    for (const r of plan.rows) {
      const res = await unstage(r);
      if (!res?.ok) break;
      out.push(r);
    }
    setBusy(false);
    // Taking out has an Undo too (17 Oct verification): what came out goes back in, the product
    // before its sites (the reverse of the order it came out in).
    if (out.length && stage) {
      const back = [...out].reverse().map((r) => ({ target: r.target, entity_id: r.entity_id, location_id: r.location_id || null, op: r.op, after: r.after, before: r.before || {} }));
      setNote({ tone: 'good', text: `Taken out of the draft: ${changeWords(row, names).subject}.`, actions: [{ label: 'Undo', onClick: () => { setNote(null); stage(back, { quiet: true }); } }] });
    }
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
      sub={working ? `Draft: ${rows.length} change${rows.length === 1 ? '' : 's'}, not on the tills yet.` : 'No draft yet: your first change starts one.'}
      footer={(
        <>
          {tabIds.includes('publish') && working?.status === 'draft' && rows.length > 0 && (
            <Btn kind="primary" onClick={() => { onClose(); setNote?.(null); setTab('publish'); }}>Review and publish</Btn>
          )}
          <div style={{ flex: 1 }} />
          {editable && working?.status === 'draft' && rows.length > 0 && <Btn kind="danger" disabled={busy} onClick={discard}>Throw away this draft</Btn>}
        </>
      )}>
      {confirmDialog}
      {!rows.length && <Notice tone="info">Your draft is empty. Change a price, turn a product on or off, add a product or change an option group, and it shows here.</Notice>}
      {groups.map((g) => (
        <div key={g.key} style={{ padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 750, marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}>{g.subject}{g.kind === 'group' && <span style={{ ...ui.sub, fontSize: 11, fontWeight: 600 }}>option group</span>}</div>
          {g.lines.map(({ row, words }) => (
            <div key={row.id || `${row.target}${row.location_id}`} style={{ ...ui.row, fontSize: 12.5, color: 'var(--t2)', padding: '2px 0' }}>
              <span style={{ flex: 1 }}>{words}</span>
              {editable && working?.status === 'draft' && row.id && <Btn small kind="link" disabled={busy} onClick={() => undoRow(row)} title="Take this change out of the draft. Nothing at any site changes.">Take out of draft</Btn>}
            </div>
          ))}
        </div>
      ))}
    </Sheet>
  );
}
