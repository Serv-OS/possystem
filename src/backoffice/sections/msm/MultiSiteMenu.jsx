// src/backoffice/sections/msm/MultiSiteMenu.jsx
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the Back Office screen. Peter: "build a multi site menu
// builder where if you want to manage a menu centrally you can: a list of products, their
// categories, if it is active at each location, what the price is at each location."
//
// Opened only by people ServOS added by name while the company is switched on (lib/boSections.js
// routeGateOk; the database checks every read and write again). Works at COMPANY level, not on the
// tab's venue.
//
// WHAT THIS FILE DOES
//   * Works out the state: not installed, nothing set up yet (the first import), or the menu.
//   * Holds the central menu as published (live), the draft being worked on and its staged
//     changes; the grid shows live with the draft applied (msmDiff.applyChanges).
//   * Every edit goes through stage(): it creates a draft when there is none, writes through
//     msmData (compare and set, saveHealth on every write) and then reads the draft back from the
//     database. Nothing shows as staged before the database said so (the vanishing categories
//     lesson).
//   * Tabs: Grid and Menu details here; more tabs plug in through EXTRA_TABS (Publish, History,
//     Sites, Spread: builder 3).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, isMock } from '../../../lib/supabase';
import { msmApi } from '../../../lib/msm/msmApi';
import { demoMsm } from '../../../lib/msm/msmDemo';
import { applyChanges } from '../../../../supabase/functions/_shared/msmDiff.js';
import { indexCentral, stagedIndex } from '../../../lib/msm/msmGrid';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';
import { isNotInstalled } from '../../../../supabase/functions/_shared/msmAccess.js';
import { Btn, Pill, Notice } from './msmUi';
import { ui } from './msmStyle';
import MsmGrid from './MsmGrid';
import MsmProductSheet from './MsmProductSheet';
import MsmChangePrices from './MsmChangePrices';
import MsmImport from './MsmImport';
import MsmDetails from './MsmDetails';
import MsmChangesPanel from './MsmChangesPanel';
import { useSiteCosts } from './useSiteCosts';
import { EXTRA_TABS } from './msmTabs';


const WORKING_KEY = (menuId) => `msm-working-set:${menuId}`;
const readWorking = (menuId) => { try { return localStorage.getItem(WORKING_KEY(menuId)) || null; } catch { return null; } };
const saveWorking = (menuId, id) => { try { if (id) localStorage.setItem(WORKING_KEY(menuId), id); else localStorage.removeItem(WORKING_KEY(menuId)); } catch { /* private mode */ } };

const draftTitle = () => `Changes ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

/** Site names (and clocks) for a list of venue ids, or for a whole company. */
async function readSites(client, { ids = null, orgId = null }) {
  if (!client) return { rows: [], error: null };
  const r = await readAllRows(() => {
    let q = client.from('locations').select('id,name,timezone,org_id');
    if (ids) q = q.in('id', ids); else q = q.eq('org_id', orgId);
    return q.order('name').order('id');
  });
  return r;
}

export default function MultiSiteMenu({ access, orgCtx, onAccessLost }) {
  const demo = isMock ? demoMsm() : null;
  const api = demo ? demo.api : msmApi;
  const client = demo ? demo.client : supabase;
  const orgId = demo ? demo.orgId : access?.orgId || null;
  const canEdit = !!access?.canEdit;

  const [phase, setPhase] = useState('loading');      // loading | missing | empty | ready | error
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(null);
  const [live, setLive] = useState(null);             // central state as published
  const [sites, setSites] = useState([]);             // [{ id, name, timezone }] in column order
  const [sets, setSets] = useState([]);
  const [workingId, setWorkingId] = useState(null);
  const [rows, setRows] = useState([]);               // staged changes of the working set
  const [busy, setBusy] = useState(0);
  const [note, setNote] = useState(null);             // { tone, text }
  const [tab, setTab] = useState('grid');
  const [sheet, setSheet] = useState(null);           // { productId } | { create: true, siteOnly } | null
  const [tool, setTool] = useState(null);             // Change prices scope | null
  const [showChanges, setShowChanges] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const [channel, setChannel] = useState(null);

  // ── Load: the live menu, then everything under it ──────────────────────
  useEffect(() => {
    if (!orgId) { setPhase('error'); setError('This login is not in a company.'); return undefined; }
    let cancelled = false;
    const live_ = () => !cancelled;
    (async () => {
      setPhase((p) => (p === 'ready' ? p : 'loading'));
      const lm = await api.liveMenu(orgId);
      if (!live_()) return;
      if (lm.error) {
        if (isNotInstalled(lm.error)) { setPhase('missing'); return; }
        setPhase('error'); setError(String(lm.error.message || 'Could not read the group menu.')); return;
      }
      if (!lm.menu) { setMenu(null); setLive(null); setPhase('empty'); return; }
      const [c, s] = await Promise.all([api.central(lm.menu.id), api.sets(lm.menu.id)]);
      if (!live_()) return;
      if (!c.ok) { setPhase('error'); setError(`Could not read the group menu (${c.failed.join(', ')}). Nothing was changed.`); return; }
      const ids = (c.sites || []).map((x) => x.location_id);
      const names = await readSites(client, { ids });
      if (!live_()) return;
      const byId = new Map((names.rows || []).map((r) => [r.id, r]));
      const cols = ids.map((id) => ({ id, name: byId.get(id)?.name || `Site ${id.slice(-4)}`, timezone: byId.get(id)?.timezone || 'Europe/London' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setMenu(c.menu); setLive(c); setSites(cols);
      const drafts = s.rows || [];
      setSets(drafts);
      const remembered = readWorking(c.menu.id);
      const pick = drafts.find((d) => d.id === remembered && d.status === 'draft') || drafts.find((d) => d.status === 'draft') || null;
      setWorkingId(pick ? pick.id : null);
      setPhase('ready');
    })();
    return () => { cancelled = true; };
  }, [api, client, orgId, reload]);

  // The working set's changes, read back from the database whenever the set changes.
  const readRows = useCallback(async (setId) => {
    if (!setId) { setRows([]); return true; }
    const r = await api.changes(setId);
    if (!r.rows) { setNote({ tone: 'bad', text: 'Could not read the draft\'s changes. Nothing was lost; try again.' }); return false; }
    setRows(r.rows);
    return true;
  }, [api]);
  useEffect(() => { if (phase === 'ready') readRows(workingId); }, [phase, workingId, readRows]);
  useEffect(() => { if (menu) saveWorking(menu.id, workingId); }, [menu, workingId]);

  const working = sets.find((s) => s.id === workingId) || null;
  const editable = canEdit && (!working || working.status === 'draft');
  const eff = useMemo(() => (live ? applyChanges(live, rows).central : null), [live, rows]);
  const ix = useMemo(() => (eff ? indexCentral(eff) : null), [eff]);
  const staged = useMemo(() => stagedIndex(rows), [rows]);
  const ctx = useMemo(() => ({ live, eff }), [live, eff]);
  const costs = useSiteCosts({ demo, sites });

  const refreshSets = useCallback(async () => {
    if (!menu) return;
    const s = await api.sets(menu.id);
    if (s.rows) setSets(s.rows);
  }, [api, menu]);

  // ── Staging: the one way every edit lands ──────────────────────────────
  const stage = useCallback(async (changes, { done } = {}) => {
    const list = (changes || []).filter(Boolean);
    if (!list.length) return { ok: true, done: 0 };
    if (!canEdit) { setNote({ tone: 'bad', text: 'You can look but not change the group menu. Ask ServOS to make you an editor.' }); return { ok: false }; }
    if (working && working.status !== 'draft') { setNote({ tone: 'warn', text: `"${working.title}" is ${working.status}. Unschedule it to change it, or pick a draft to work on.` }); return { ok: false }; }
    setBusy((n) => n + 1);
    try {
      let setId = workingId;
      if (!setId) {
        const d = await api.createDraft(menu.id, draftTitle(), 'edit');
        if (!d.ok) { setNote({ tone: 'bad', text: d.words }); return { ok: false }; }
        setId = d.data.id;
        setSets((s) => [d.data, ...s]);
        setWorkingId(setId);
      }
      const r = await api.stageMany(setId, list, setId === workingId ? rows : []);
      await readRows(setId);
      if (r.conflicts) setNote({ tone: 'warn', text: `${r.conflicts} of these were changed by someone else at the same moment. The grid shows their change now.` });
      else if (r.failed?.length) {
        if ((r.failed[0].words || '').includes('cannot change the group menu')) onAccessLost?.();
        setNote({ tone: 'bad', text: `${r.failed.length} change${r.failed.length === 1 ? '' : 's'} did not save: ${r.failed[0].words}` });
      } else if (done) setNote({ tone: 'good', text: done });
      return r;
    } finally {
      setBusy((n) => n - 1);
    }
  }, [api, canEdit, menu, onAccessLost, readRows, rows, working, workingId]);

  const unstage = useCallback(async (row) => {
    setBusy((n) => n + 1);
    try {
      const r = await api.unstage(row);
      await readRows(workingId);
      if (!r.ok) setNote({ tone: r.conflict ? 'warn' : 'bad', text: r.words });
      return r;
    } finally { setBusy((n) => n - 1); }
  }, [api, readRows, workingId]);

  // ── Screens ────────────────────────────────────────────────────────────
  if (phase === 'loading') return <div style={ui.page}><Header /><div style={ui.sub}>Loading the group menu…</div></div>;
  if (phase === 'missing') return <div style={ui.page}><Header /><Notice>Not installed yet. The Multi site menu appears once ServOS has run its database update.</Notice></div>;
  if (phase === 'error') return (
    <div style={ui.page}><Header />
      <Notice tone="bad">{error}</Notice>
      <div style={{ marginTop: 12 }}><Btn onClick={() => setReload((n) => n + 1)}>Try again</Btn></div>
    </div>
  );
  if (phase === 'empty' || importing) {
    if (importing && canEdit) {
      return (
        <div style={ui.page}>
          <MsmImport api={api} client={client} orgId={orgId} orgName={access?.orgName || orgCtx?.orgName || ''} readSites={readSites}
            onCancel={() => setImporting(false)} onDone={() => { setImporting(false); setReload((n) => n + 1); }} />
        </div>
      );
    }
    return (
      <div style={ui.page}>
        <Header />
        <div style={{ ...ui.card, maxWidth: 640, padding: 26 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.01em', marginBottom: 6 }}>Set up your multi site menu</div>
          <div style={{ ...ui.sub, fontSize: 13.5, marginBottom: 16 }}>
            One menu for every site: the products, their categories, which sites sell each one and the price at each site.
            We read the menus your sites have today and match them up. Setting up changes nothing at any site: the tills keep selling exactly as they do now until somebody publishes.
          </div>
          {canEdit
            ? <Btn kind="primary" onClick={() => setImporting(true)}>Start: read my sites' menus</Btn>
            : <Notice>Nobody has set up the group menu yet. An editor can do it from here.</Notice>}
        </div>
      </div>
    );
  }

  const tabs = [{ id: 'grid', label: 'Menu' }, { id: 'details', label: 'Menu details' }, ...EXTRA_TABS];
  const extra = EXTRA_TABS.find((t) => t.id === tab);
  const shared = { tabIds: tabs.map((t) => t.id), api, client, menu, live, eff, ix, sites, sets, working, rows, staged, ctx, stage, unstage, canEdit, editable, costs, channel, setChannel, refreshSets, reload: () => setReload((n) => n + 1), setWorkingId, setNote, setTab };

  return (
    <div style={{ ...ui.page, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
      <Header menu={menu} sites={sites}>
        <WorkingOn sets={sets} working={working} canEdit={canEdit} api={api} menu={menu}
          onPick={setWorkingId} onSets={setSets} onNote={setNote} />
        <Btn kind={staged.count ? 'primary' : 'soft'} onClick={() => setShowChanges(true)} data-testid="msm-changes-button">
          Changes{staged.count ? ` (${staged.count})` : ''}
        </Btn>
      </Header>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--bdr)', marginBottom: 14 }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} style={{ padding: '9px 14px', fontSize: 14, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'inherit',
            color: tab === t.id ? 'var(--t1)' : 'var(--t3)', fontWeight: tab === t.id ? 700 : 500, borderBottom: `2.5px solid ${tab === t.id ? 'var(--acc)' : 'transparent'}`, marginBottom: -1 }}>{t.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        {busy > 0 && <span style={{ ...ui.sub, alignSelf: 'center' }}>Saving…</span>}
      </div>

      {note && <div style={{ marginBottom: 12 }}><Notice tone={note.tone} onClose={() => setNote(null)}>{note.text}</Notice></div>}
      {working && working.status !== 'draft' && (
        <div style={{ marginBottom: 12 }}><Notice>Viewing "{working.title}" as it will be once it runs ({working.status}). It cannot be edited while it is {working.status}.</Notice></div>
      )}

      {tab === 'grid' && (
        <MsmGrid {...shared}
          onOpenProduct={(id) => setSheet({ productId: id })}
          onAddProduct={(siteOnly) => setSheet({ create: true, siteOnly: siteOnly || null })}
          onChangePrices={(scope) => setTool(scope || { all: true })} />
      )}
      {tab === 'details' && <MsmDetails {...shared} />}
      {extra && extra.render(shared)}

      {sheet && (
        <MsmProductSheet key={sheet.productId || `new:${sheet.siteOnly || ''}`} {...shared} productId={sheet.productId || null} create={!!sheet.create} siteOnly={sheet.siteOnly || null}
          onClose={() => setSheet(null)} onCreated={(id) => setSheet({ productId: id })} />
      )}
      {tool && <MsmChangePrices {...shared} initialScope={tool} onClose={() => setTool(null)} />}
      {showChanges && <MsmChangesPanel {...shared} onClose={() => setShowChanges(false)} />}
    </div>
  );
}

function Header({ menu, sites, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: 'var(--t4)', textTransform: 'uppercase' }}>Multi site menu</div>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.6px', margin: '4px 0 2px', color: 'var(--t1)' }}>{menu?.name || 'Group menu'}</h1>
        {menu && (
          <div style={ui.sub}>
            {sites?.length || 0} site{sites?.length === 1 ? '' : 's'}
            {menu.last_published_at ? ` · last published ${new Date(menu.last_published_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${menu.last_published_by ? ` by ${menu.last_published_by}` : ''}` : ''}
          </div>
        )}
      </div>
      {children && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

// "Working on": which draft the edits land in, or a scheduled set to view as it will be.
function WorkingOn({ sets, working, canEdit, api, menu, onPick, onSets, onNote }) {
  const [naming, setNaming] = useState(null);   // { id|null, title }
  const drafts = sets.filter((s) => s.status === 'draft');
  const others = sets.filter((s) => s.status !== 'draft');
  const save = async () => {
    const t = String(naming.title || '').trim();
    if (!t) return;
    const r = naming.id ? await api.renameDraft(naming.id, t) : await api.createDraft(menu.id, t, 'edit');
    if (!r.ok) { onNote({ tone: 'bad', text: r.words }); return; }
    const s = await api.sets(menu.id);
    if (s.rows) onSets(s.rows);
    if (!naming.id) onPick(r.data.id);
    setNaming(null);
  };
  if (naming) {
    return (
      <div style={{ ...ui.row }}>
        <input autoFocus style={{ ...ui.input, width: 220 }} value={naming.title} maxLength={80} placeholder="Name it, like Christmas menu"
          onChange={(e) => setNaming({ ...naming, title: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setNaming(null); }} />
        <Btn small kind="primary" onClick={save}>Save</Btn>
        <Btn small onClick={() => setNaming(null)}>Cancel</Btn>
      </div>
    );
  }
  return (
    <div style={{ ...ui.row }}>
      <span style={{ ...ui.sub, whiteSpace: 'nowrap' }}>Working on</span>
      <select aria-label="Working on" style={{ ...ui.input, width: 230 }} value={working?.id || ''} onChange={(e) => { if (e.target.value === '__new') setNaming({ id: null, title: '' }); else onPick(e.target.value || null); }}>
        <option value="">{drafts.length ? 'Nothing (the menu as published)' : 'A new draft (made on your first change)'}</option>
        {drafts.map((d) => <option key={d.id} value={d.id}>Draft: {d.title}</option>)}
        {others.map((d) => <option key={d.id} value={d.id}>{d.status === 'scheduled' ? 'Scheduled' : 'Running'}: {d.title}</option>)}
        {canEdit && <option value="__new">+ New draft…</option>}
      </select>
      {canEdit && working?.status === 'draft' && <Btn small kind="link" onClick={() => setNaming({ id: working.id, title: working.title })}>Rename</Btn>}
      {working && <Pill tone={working.status === 'draft' ? 'acc' : 'blue'}>{working.status === 'draft' ? 'Draft' : working.status}</Pill>}
    </div>
  );
}
