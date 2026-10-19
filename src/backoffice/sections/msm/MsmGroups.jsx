// src/backoffice/sections/msm/MsmGroups.jsx
//
// MULTI SITE MENU, ROUND 2 (v5.11.75): the Option groups tab. Peter, 17 Oct 2026: "It would be good
// to be able to build modifier groups here and push them across the company, and set things like
// sub items, and sub items that can be sold separately, and manage the groups globally and push
// similar changes like we have."
//
// Left: every option group, with search, "used by N products", how many sites, and a filter for
// the groups that differ between sites. Right: the group (MsmGroupSheet.jsx). Edits go into the
// draft like every other change: nothing reaches a till until the draft is published.
//
// A group brought in before round 2 holds its options as one list. Those need a one time refresh
// from the sites before their options can be edited here (design 1.9): the msm-publish function
// reads every site, proves that nothing would change at any site, and only then saves.

import { useEffect, useMemo, useRef, useState } from 'react';
import { groupList, legacyGroupIds } from '../../../lib/msm/msmGroupView';
import { HELP } from '../../../lib/msm/msmWords';
import { whyReadOnly, refreshClash, REFRESH_CLASH_WORDS } from '../../../lib/msm/msmStatus';
import { Btn, Pill, Notice } from './msmUi';
import { ui } from './msmStyle';
import { useConfirm } from './useConfirm';
import MsmGroupSheet from './MsmGroupSheet';

const FILTERS = [
  { id: 'all', label: 'Every option group' },
  { id: 'differ', label: 'Differs between sites' },
  { id: 'unused', label: 'Not on any product' },
  { id: 'removed', label: 'Removed' },
];

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

export default function MsmGroups(props) {
  const { api, menu, live, eff, rows, canEdit, editable, working, setNote, reload, pick, onPick } = props;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(null);       // id of a new group being made
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const list = useMemo(() => groupList(eff, { search, filter }), [eff, search, filter]);
  const legacy = useMemo(() => legacyGroupIds(eff), [eff]);
  const touched = useMemo(() => {
    const s = new Set();
    const optionGroup = new Map((eff?.options || []).map((o) => [o.id, o.group_id]));
    for (const r of rows || []) {
      if (r.target === 'modifier_group' || r.target === 'modifier_group_site') s.add(r.entity_id);
      if (r.target === 'modifier_option') s.add(r.after?.group_id || optionGroup.get(r.entity_id));
      if (r.target === 'modifier_option_site') s.add(optionGroup.get(r.entity_id));
    }
    return s;
  }, [rows, eff]);
  const why = whyReadOnly({ canEdit, working });
  // An iPad in portrait (under 720 px): the list OR the group, with a way back, so a tapped group is
  // never drawn below the fold under a tall list (round 2 review).
  const [narrow, setNarrow] = useState(() => { try { return window.matchMedia('(max-width: 719px)').matches; } catch { return false; } });
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia('(max-width: 719px)'); } catch { return undefined; }
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  const sheetRef = useRef(null);
  useEffect(() => { if (narrow && (pick || creating)) sheetRef.current?.scrollIntoView?.({ block: 'start' }); }, [narrow, pick, creating]);
  const round2 = live?.round2 !== false;
  const current = creating ? null : (list.find((g) => g.group.id === pick) || (pick && (eff?.groups || []).some((g) => g.id === pick) ? { group: eff.groups.find((g) => g.id === pick) } : null));

  const refresh = async () => {
    const yes = await confirm({
      title: 'Refresh option groups from the sites?',
      words: 'We read every site\'s option groups and bring their options in, one by one, with each site\'s own prices. Nothing changes at any site: if anything would, nothing is saved and we say what.',
      yes: 'Refresh them', no: 'Not now',
    });
    if (!yes) return;
    setRefreshing(true);
    const r = await api.refreshGroups(menu.id);
    setRefreshing(false);
    if (!r.ok) { setNote({ tone: 'bad', text: `Nothing was changed. ${r.words || ''}`.trim() }); return; }
    setNote({ tone: 'good', text: r.data?.words || 'Option groups refreshed from the sites. Nothing changed at any site.' });
    reload();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
      {confirmDialog}
      {!round2 && (
        <Notice tone="info">Option groups can be built here once ServOS has run this release's database update. Until then each site sets its own in Menu Manager, and the products here keep the groups they have.</Notice>
      )}
      {round2 && legacy.length > 0 && (
        <Notice tone="warn" actions={canEdit ? [{ label: refreshing ? 'Refreshing…' : 'Refresh option groups from the sites', kind: 'primary', onClick: refresh, disabled: refreshing || refreshClash(rows) }] : null}>
          {legacy.length} option group{legacy.length === 1 ? ' was' : 's were'} brought in before they could be edited here. A one time refresh from the sites brings in each option with each site's own price. Nothing changes at any site.
          {refreshClash(rows) && ` ${REFRESH_CLASH_WORDS}`}
        </Notice>
      )}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start', minHeight: 0, flex: 1 }}>
        {/* The list */}
        {!(narrow && (creating || current?.group)) && (
        <div style={{ ...ui.card, padding: 12, flex: '1 1 250px', maxWidth: narrow ? 'none' : 340, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'calc(100vh - 260px)', boxSizing: 'border-box' }}>
          <div style={{ ...ui.row }}>
            <div style={{ ...ui.h2, flex: 1, margin: 0 }}>Option groups</div>
            {canEdit && <Btn small kind="primary" disabled={!editable || !round2} title={why || undefined} onClick={() => { setCreating(newId()); onPick(null); }}>New option group</Btn>}
          </div>
          <div style={{ ...ui.sub, fontSize: 11.5 }}>{HELP.optionGroup}</div>
          <input aria-label="Find an option group" style={ui.input} placeholder="Find a group or an option" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select aria-label="Show option groups" style={ui.input} value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div style={{ overflowY: 'auto', margin: '0 -4px', flex: 1 }}>
            {!list.length && (
              <div style={{ ...ui.sub, padding: '14px 6px' }}>
                {search || filter !== 'all'
                  ? <>No option groups match. <Btn small kind="link" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</Btn></>
                  : 'No option groups yet. Make one, like Milk, with New option group.'}
              </div>
            )}
            {list.map((g) => {
              const on = !creating && current?.group?.id === g.group.id;
              return (
                // 17 Oct verification: every mark here says what it means in words (an iPad shows no
                // hover title), and a long name wraps instead of being cut off.
                <button key={g.group.id} type="button" title={g.group.name} onClick={() => { setCreating(null); onPick(g.group.id); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', margin: '2px 0', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--t1)',
                    border: `1px solid ${on ? 'var(--acc)' : 'transparent'}`, background: on ? 'var(--acc-d)' : 'transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {touched.has(g.group.id) && <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: 'var(--amber, #F5A623)', flexShrink: 0 }} />}
                    <span style={{ fontSize: 13.5, fontWeight: 750, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{g.group.name}</span>
                    {round2 && g.legacy && <Pill tone="warn">Needs refresh</Pill>}
                  </div>
                  <div style={{ ...ui.sub, fontSize: 11.5 }}>
                    {g.rule} · {g.options.length} option{g.options.length === 1 ? '' : 's'} · {g.words}
                    {g.differs && <span style={{ color: 'var(--blu)', fontWeight: 650 }}> · not the same at every site</span>}
                    {touched.has(g.group.id) && <span style={{ color: 'var(--amber, #F5A623)', fontWeight: 650 }}> · changed in the draft</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        )}

        {/* The group */}
        {!(narrow && !creating && !current?.group) && (
        <div ref={sheetRef} style={{ flex: '3 1 400px', minWidth: 0 }}>
          {narrow && (creating || current?.group) && <div style={{ marginBottom: 8 }}><Btn small kind="soft" onClick={() => { setCreating(null); onPick(null); }}>‹ Back to option groups</Btn></div>}
          {creating && <MsmGroupSheet key={creating} {...props} groupId={creating} isNew onSaved={(id) => { setCreating(null); onPick(id); }} onCancel={() => setCreating(null)} />}
          {!creating && current?.group && <MsmGroupSheet key={current.group.id} {...props} groupId={current.group.id} isNew={false} onSaved={() => {}} onCancel={() => onPick(null)} />}
          {!creating && !current?.group && (
            <div style={{ ...ui.card, padding: 26 }}>
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>Pick an option group</div>
              <div style={{ ...ui.sub, fontSize: 13, maxWidth: 560 }}>
                An option group is a question the till asks, like Milk, Syrups or Choose 3 donuts. Build it once here and it goes to every site that sells a product with it, with each site's own prices where they differ.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 14 }}>
                <Tip title="Options and prices" words="Each option has a group price, and a site can have its own." />
                <Tip title="Sub items" words={HELP.subItem} />
                <Tip title="Also sold on its own" words={HELP.soldAlone} />
              </div>
              {canEdit && round2 && <div style={{ marginTop: 16 }}><Btn kind="primary" disabled={!editable} title={why || undefined} onClick={() => setCreating(newId())}>New option group</Btn>{why && <div style={{ ...ui.sub, marginTop: 6 }}>{why}</div>}</div>}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function Tip({ title, words }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 13, fontWeight: 750 }}>{title}</div>
      <div style={{ ...ui.sub, fontSize: 12 }}>{words}</div>
    </div>
  );
}
