// src/backoffice/sections/stock/SiteGroupsCard.jsx
//
// MULTI SITE STOCK, Drop 1 (map 1 "Site groups", design 2.1 and A8, contract 3.5 and 4.4): groups of
// sites for the stock site picker (North, South, a brand). Shown in Location settings only in a multi
// site company, and only to an owner of that company or a Stock control All sites login (the
// server's level, stockControlWords groupsCardShows). Everyone else, and every one site company, sees
// nothing here: Location settings stays exactly today's screen.
//
// Saves through stock_save_site_group (create, or edit with the group's row_version) and
// stock_delete_site_group; then the scope reloads so the picker shows the change at once. Deleting a
// group never changes a site.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { groupsCardShows, groupFromRow, groupProblem, groupSaveArg, groupSitesWords } from '../../../lib/stock/stockControlWords';
import { Btn, Modal, Field, SiteChecklist, ErrorLine, EmptyLine, useConfirm, ui } from './stockUi';

// Location settings' own card look (its S.card), below its Save row.
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 24, marginTop: 20, marginBottom: 20 };

// The company's groups with their versions (the scope's list carries no row_version).
const readGroups = (orgId) => stockApi.siteGroups(orgId);

export default function SiteGroupsCard() {
  const sc = useStockScope();
  if (!groupsCardShows(sc)) return null;
  return <SiteGroups sc={sc} />;
}

function SiteGroups({ sc }) {
  const showToast = useStore((s) => s.showToast);
  const [confirm, confirmDialog] = useConfirm();
  const [read, setRead] = useState(null);       // { orgId, groups, error }
  const [reloads, setReloads] = useState(0);
  const [draft, setDraft] = useState(null);     // { id, name, locationIds, sortOrder, rowVersion } | null
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!sc.orgId) return undefined;
    let live = true;
    readGroups(sc.orgId).then((r) => {
      if (live) setRead({ orgId: sc.orgId, groups: r.error ? null : (r.data || []).map(groupFromRow), error: r.error || null });
    });
    return () => { live = false; };
  }, [sc.orgId, reloads]);

  const mine = read && read.orgId === sc.orgId ? read : null;
  const groups = mine?.groups || null;
  const sites = sc.sites || [];
  const nameOf = (id) => sc.siteName(id);
  const afterChange = () => { setReloads((n) => n + 1); sc.reload(); };

  const startNew = () => { setProblem(''); setDraft({ id: null, name: '', locationIds: [], sortOrder: (groups || []).length, rowVersion: null }); };
  const startEdit = (g) => { setProblem(''); setDraft({ ...g }); };

  const save = async () => {
    const why = groupProblem(draft, groups || []);
    if (why) { setProblem(why); return; }
    setBusy(true);
    const r = await stockApi.saveSiteGroup(groupSaveArg(draft, sc.orgId));
    setBusy(false);
    if (r.error) { setProblem(r.error.message || 'It did not save. Try again.'); if (r.conflict) setReloads((n) => n + 1); return; }
    setDraft(null);
    showToast?.(`Group ${draft.name.trim()} saved. It is in the site picker now.`, 'success');
    afterChange();
  };

  const remove = async (g) => {
    const ok = await confirm({ title: `Delete the group ${g.name}?`, words: 'The sites stay as they are.', yes: 'Delete', no: 'Keep it', danger: true });
    if (!ok) return;
    setBusy(true);
    const r = await stockApi.deleteSiteGroup(g.id);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message || 'It did not delete. Try again.', 'error'); return; }
    showToast?.(`Group ${g.name} deleted. The sites stay as they are.`, 'success');
    afterChange();
  };

  const dirty = !!draft && (draft.id
    ? JSON.stringify([draft.name, draft.locationIds]) !== JSON.stringify([(groups || []).find((g) => g.id === draft.id)?.name, (groups || []).find((g) => g.id === draft.id)?.locationIds])
    : !!(draft.name.trim() || draft.locationIds.length));

  return (
    <div style={card} data-testid="stock-site-groups">
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ flex: '1 1 260px' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>Site groups</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', lineHeight: 1.6 }}>Groups of sites for the site picker, for example North or South.</div>
        </div>
        <Btn kind="primary" small disabled={busy || !groups} onClick={startNew}>+ Add a group</Btn>
      </div>
      <ErrorLine error={mine?.error} />
      {!mine && <EmptyLine>Loading{'…'}</EmptyLine>}
      {groups && groups.length === 0 && <EmptyLine>No groups yet.</EmptyLine>}
      <div style={{ display: 'grid', gap: 8 }}>
        {(groups || []).map((g) => (
          <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{g.name}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{groupSitesWords(g, nameOf)}</div>
            </div>
            <Btn small kind="soft" disabled={busy} onClick={() => startEdit(g)}>Edit</Btn>
            <Btn small kind="danger" disabled={busy} onClick={() => remove(g)}>Delete</Btn>
          </div>
        ))}
      </div>

      {draft && (
        <Modal title={draft.id ? `Edit ${groupsName(draft, groups)}` : 'Add a group'} width={520} onClose={() => setDraft(null)} dirty={dirty}
          footer={(
            <>
              {problem && <div role="alert" style={{ ...ui.err, flex: '1 1 100%' }}>{problem}</div>}
              <span style={{ flex: 1 }} />
              <Btn onClick={() => setDraft(null)} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
            </>
          )}>
          <Field label="Name">
            <input value={draft.name} maxLength={80} autoFocus onChange={(e) => { setProblem(''); setDraft({ ...draft, name: e.target.value }); }}
              style={ui.input} aria-label="Name" />
          </Field>
          <Field label="Sites">
            <SiteChecklist sites={sites} value={draft.locationIds} groups={[]}
              onChange={(ids) => { setProblem(''); setDraft({ ...draft, locationIds: ids }); }} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

// The title of the edit box: the group's saved name (the draft may be mid rename).
function groupsName(draft, groups) {
  return (groups || []).find((g) => g.id === draft.id)?.name || draft.name || 'group';
}
