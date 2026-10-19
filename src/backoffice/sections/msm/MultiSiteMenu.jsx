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
//   * Tabs: Menu and Option groups here; Review and publish, Scheduled and history, Sites and Price
//     check plug in through EXTRA_TABS (msmTabs.js); Menu details sits behind its own link. Export
//     and Import of the spreadsheet open from the grid's More menu.
//
// ROUND 2 (17 Oct 2026, the clarity pass; Peter after round 1: "rather confusing in places"):
//   * A STATUS BAR under the tabs says, always, whether what you see is the live menu, a draft that
//     is not on the tills yet, or a scheduled push you are only looking at (lib/msm/msmStatus.js).
//   * One draft at a time: the "Your changes go into" picker shows only when there are two drafts
//     or a scheduled push. Draft names carry the time.
//   * Every note after an edit carries its way on: [Undo] for a single action, [Review and publish].
//   * A first run guide, four steps, closed once and remembered (localStorage, try and catch).
//   * The sites' own VAT rates and last week's sales are read once here and shared, for the VAT by
//     order type pickers and the warnings that need a tick (msmRisk.js).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, isMock } from '../../../lib/supabase';
import { msmApi } from '../../../lib/msm/msmApi';
import { salesMap } from '../../../lib/msm/msmData';
import { demoMsm } from '../../../lib/msm/msmDemo';
import BetaTag from '../../../components/BetaTag';
import { applyChanges } from '../../../../supabase/functions/_shared/msmDiff.js';
import { indexCentral, stagedIndex } from '../../../lib/msm/msmGrid';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';
import { isNotInstalled } from '../../../../supabase/functions/_shared/msmAccess.js';
import { Btn, Pill, Notice, Count } from './msmUi';
import { statusBar, draftTitle, GUIDE_STEPS, guideClosed, setGuideClosed, undoFor, draftToStageInto, undoTarget, draftCount } from '../../../lib/msm/msmStatus';
import { changeKey } from '../../../../supabase/functions/_shared/msmDiff.js';
import MsmGroups from './MsmGroups';
import { WORDS } from '../../../lib/msm/msmWords';
import { ui } from './msmStyle';
import MsmGrid from './MsmGrid';
import MsmProductSheet from './MsmProductSheet';
import MsmChangePrices from './MsmChangePrices';
import MsmImport from './MsmImport';
import MsmDetails from './MsmDetails';
import MsmChangesPanel from './MsmChangesPanel';
import MsmCsv from './MsmCsv';
import { useSiteCosts } from './useSiteCosts';
import { EXTRA_TABS } from './msmTabs';


const WORKING_KEY = (menuId) => `msm-working-set:${menuId}`;
const readWorking = (menuId) => { try { return localStorage.getItem(WORKING_KEY(menuId)) || null; } catch { return null; } };
const saveWorking = (menuId, id) => { try { if (id) localStorage.setItem(WORKING_KEY(menuId), id); else localStorage.removeItem(WORKING_KEY(menuId)); } catch { /* private mode */ } };
// The tab this person had open last (design 4: remember the viewer's tab), per browser.
const TAB_KEY = 'msm-last-tab';
const KNOWN_TABS = () => ['grid', 'groups', 'details', ...EXTRA_TABS.map((t) => t.id)];
const readTab = () => { try { const t = localStorage.getItem(TAB_KEY); return t && KNOWN_TABS().includes(t) ? t : 'grid'; } catch { return 'grid'; } };
const saveTab = (t) => { try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ } };


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
  const [tab, setTabState] = useState(readTab);
  const setTab = useCallback((t) => { setTabState(t); saveTab(t); }, []);
  const [sheet, setSheet] = useState(null);           // { productId } | { create: true } | null
  const [tool, setTool] = useState(null);             // Change prices scope | null
  const [showChanges, setShowChanges] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const [channel, setChannel] = useState(null);
  const [csv, setCsv] = useState(null);               // 'export' | 'import' | null
  const [groupPick, setGroupPick] = useState(null);   // the option group to open on the Option groups tab
  const [guide, setGuide] = useState(false);          // the first run guide is showing
  const [ratesByLoc, setRatesByLoc] = useState({});   // each site's own VAT rates (tax_rates rows)
  const [sales, setSales] = useState(undefined);      // undefined reading, null not read, Map(loc|venueItemId -> sold in 7 days)

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
  // The latest read wins (UI issue 10b): the first edit of a session sets the new draft (whose
  // effect reads it, still empty) and reads it again after the write; an older answer arriving last
  // must never wipe the change from the status bar and the grid.
  const readSeq = useRef(0);
  const readRows = useCallback(async (setId) => {
    const my = ++readSeq.current;
    if (!setId) { setRows([]); return true; }
    const r = await api.changes(setId);
    if (my !== readSeq.current) return true;
    if (!r.rows) { setNote({ tone: 'bad', text: 'Could not read the draft\'s changes. Nothing was lost; try again.' }); return false; }
    setRows(r.rows);
    return true;
  }, [api]);
  useEffect(() => { if (phase === 'ready') readRows(workingId); }, [phase, workingId, readRows]);
  useEffect(() => { if (menu) saveWorking(menu.id, workingId); }, [menu, workingId]);

  // Each site's own VAT rates (for VAT by order type and the live example), read once.
  const siteKey = sites.map((x) => x.id).join('|');
  useEffect(() => {
    if (phase !== 'ready' || !client || !siteKey) return undefined;
    let on = true;
    readAllRows(() => client.from('tax_rates').select('*').in('location_id', siteKey.split('|')).order('location_id').order('id')).then((r) => {
      if (!on || !r.rows) return;
      const m = {};
      for (const loc of siteKey.split('|')) m[loc] = [];
      for (const row of r.rows) (m[row.location_id] = m[row.location_id] || []).push(row);
      setRatesByLoc(m);
    });
    return () => { on = false; };
  }, [phase, client, siteKey]);
  // Last week's sales per site and product, for "Latte sold 214 times at Leeds" (one read).
  useEffect(() => {
    if (phase !== 'ready' || !menu?.id || !api.soldRecently) return undefined;
    let on = true;
    api.soldRecently(menu.id, 7).then((r) => {
      if (!on) return;
      setSales(salesMap(r));
    });
    return () => { on = false; };
  }, [phase, menu?.id, api]);
  // The first run guide shows until this person closes it once.
  useEffect(() => { if (phase === 'ready' && menu?.id) setGuide(!guideClosed(menu.id)); }, [phase, menu?.id]);

  const working = sets.find((s) => s.id === workingId) || null;
  const editable = canEdit && (!working || working.status === 'draft');
  const eff = useMemo(() => (live ? applyChanges(live, rows).central : null), [live, rows]);
  const ix = useMemo(() => (eff ? indexCentral(eff) : null), [eff]);
  const staged = useMemo(() => stagedIndex(rows), [rows]);
  const ctx = useMemo(() => ({ live, eff }), [live, eff]);
  const costs = useSiteCosts({ demo, sites });
  // The latest draft rows and central state, for an Undo pressed after later edits.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const effRef = useRef(eff);
  effRef.current = eff;
  // The latest sets and pick, for an Undo pressed after a publish (it must never stage then).
  const setsRef = useRef(sets);
  setsRef.current = sets;
  const workingIdRef = useRef(workingId);
  workingIdRef.current = workingId;

  const refreshSets = useCallback(async () => {
    if (!menu) return;
    const s = await api.sets(menu.id);
    if (s.rows) setSets(s.rows);
  }, [api, menu]);

  // ── Staging: the one way every edit lands ──────────────────────────────
  const undoRef = useRef(null);
  const stage = useCallback(async (changes, { done, undo = false, quiet = false } = {}) => {
    const list = (changes || []).filter(Boolean);
    if (!list.length) return { ok: true, done: 0 };
    // Worked out before the write, from what the screen showed: what Undo puts back (undoRef is
    // set below, after unstage, so an Undo pressed later uses the latest rows).
    const back = undo ? undoFor(effRef.current, list, rowsRef.current) : null;
    if (!canEdit) { setNote({ tone: 'bad', text: 'You can look but not change the group menu. Ask ServOS to make you an editor.' }); return { ok: false }; }
    if (working && working.status !== 'draft') { setNote({ tone: 'warn', text: `"${working.title}" is ${working.status}. Unschedule it to change it, or pick a draft to work on.` }); return { ok: false }; }
    setBusy((n) => n + 1);
    try {
      // One draft at a time (design 2 item 3): with none picked, the only draft there is takes it.
      let setId = draftToStageInto(sets, workingId);
      let started = null;
      if (setId && setId !== workingId) setWorkingId(setId);
      if (!setId) {
        const d = await api.createDraft(menu.id, draftTitle(new Date(), sites[0]?.timezone || 'Europe/London'), 'edit');
        if (!d.ok) { setNote({ tone: 'bad', text: d.words }); return { ok: false }; }
        setId = d.data.id;
        started = d.data.title;
        setSets((s) => [d.data, ...s]);
        setWorkingId(setId);
      }
      // The draft's rows to merge into: the screen's own, or (a draft just picked up) read first.
      let baseRows = setId === workingId ? rows : [];
      if (setId !== workingId && !started) baseRows = (await api.changes(setId)).rows || [];
      const r = await api.stageMany(setId, list, baseRows);
      await readRows(setId);
      if (r.conflicts) setNote({ tone: 'warn', text: `${r.conflicts} of these were changed by someone else at the same moment. The grid shows their change now.` });
      else if (r.failed?.length) {
        if ((r.failed[0].words || '').includes('cannot change the group menu')) onAccessLost?.();
        setNote({ tone: 'bad', text: `${r.failed.length} change${r.failed.length === 1 ? '' : 's'} did not save: ${r.failed[0].words}` });
      } else if (done && !quiet) {
        // The status bar already offers Review and publish: the note keeps only Undo, tied to the
        // draft this change went into (17 Oct verification).
        const actions = [];
        if (back) actions.push({ label: 'Undo', onClick: () => undoRef.current?.(back, setId) });
        setNote({ tone: 'good', text: started ? `Started a draft called "${started}". ${done} Your changes collect in this draft until you publish.` : done, actions });
        // The first edit is the guide's last step: it folds away so the grid has the room.
        setGuide(false);
        if (menu?.id) setGuideClosed(menu.id, true);
      }
      return r;
    } finally {
      setBusy((n) => n - 1);
    }
  }, [api, canEdit, menu, onAccessLost, readRows, rows, sets, sites, working, workingId]);

  // Undo of a single action: put each field back, and take out what that action created.
  const unstage = useCallback(async (row) => {
    setBusy((n) => n + 1);
    try {
      const r = await api.unstage(row);
      await readRows(workingId);
      if (!r.ok) setNote({ tone: r.conflict ? 'warn' : 'bad', text: r.words });
      return r;
    } finally { setBusy((n) => n - 1); }
  }, [api, readRows, workingId]);

  undoRef.current = async (back, noteSetId = null) => {
    const can = undoTarget({ sets: setsRef.current, workingId: workingIdRef.current, noteSetId });
    if (!can.ok) { setNote({ tone: 'warn', text: can.words }); return; }
    setNote(null);
    // A turn on taken out of the draft again comes back as it was (its create rows staged again).
    const again = [...(back.restage || []), ...back.updates];
    if (again.length) await stage(again, { quiet: true });
    for (const key of back.unstageKeys) {
      const row = (rowsRef.current || []).find((r) => changeKey(r) === key);
      if (row) await unstage(row);
    }
    setNote({ tone: 'good', text: 'Taken back. The draft is as it was.' });
  };
  const closeGuide = () => { setGuide(false); if (menu?.id) setGuideClosed(menu.id, true); };

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

  // "Products", not "Menu" (UI issue 12d): the next release adds a tab per menu beside it.
  const tabs = [{ id: 'grid', label: WORDS.productsTab }, { id: 'groups', label: 'Option groups' }, ...EXTRA_TABS, { id: 'details', label: 'Menu details', settings: true }];
  const extra = EXTRA_TABS.find((t) => t.id === tab);
  const waitingDraft = !working ? sets.find((d) => d.status === 'draft') || null : null;
  const status = statusBar({ working, rows, when: runWords(working?.run_local), draft: waitingDraft, central: eff });
  // The one counting rule (msmStatus.draftCount), the same number and words on every screen.
  const counted = draftCount(rows, eff);
  const shared = {
    counted, tabIds: tabs.map((t) => t.id), api, client, menu, live, eff, ix, sites, sets, working, rows, staged, ctx, stage, unstage, canEdit, editable, costs, channel, setChannel,
    refreshSets, reload: () => setReload((n) => n + 1), setWorkingId, setNote, setTab, ratesByLoc, sales,
    openProduct: (id) => setSheet({ productId: id }), openGroup: (id) => { setGroupPick(id); setTab('groups'); },
  };
  const showPicker = sets.filter((x) => x.status === 'draft').length >= 2 || sets.some((x) => x.status !== 'draft');

  return (
    <div style={{ ...ui.page, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
      <Header menu={menu} sites={sites} onGuide={() => setGuide(true)}>
        {showPicker && (
          <WorkingOn sets={sets} working={working} rows={rows} counted={counted} canEdit={canEdit} api={api} menu={menu}
            onPick={setWorkingId} onSets={setSets} onNote={setNote} />
        )}
        <Btn kind={counted.total && working?.status === 'draft' ? 'primary' : 'soft'} onClick={() => { setNote(null); setTab('publish'); }} data-testid="msm-changes-button"
          title={counted.total && working?.status === 'draft' ? counted.words : undefined}>
          Review and publish{counted.total && working?.status === 'draft' ? ` (${counted.total})` : ''}
        </Btn>
      </Header>

      {/* The tabs wrap onto a second line on an iPad, never cut off with no hint (17 Oct verification). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: '1px solid var(--bdr)', marginBottom: 10, flexShrink: 0 }}>
        {tabs.filter((t) => !t.settings).map((t) => (
          <button key={t.id} type="button" onClick={() => { if (t.id !== tab) setNote(null); setTab(t.id); }} style={{ padding: '9px 14px', fontSize: 14, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0,
            color: tab === t.id ? 'var(--t1)' : 'var(--t3)', fontWeight: tab === t.id ? 700 : 500, borderBottom: `2.5px solid ${tab === t.id ? 'var(--acc)' : 'transparent'}`, marginBottom: -1 }}>{t.label}{t.badge && <Count n={t.badge(shared)} tone={t.badgeTone} />}</button>
        ))}
        <div style={{ flex: 1 }} />
        {busy > 0 && <span style={{ ...ui.sub, alignSelf: 'center', marginRight: 8 }}>Saving…</span>}
        <button type="button" onClick={() => { setNote(null); setTab('details'); }} title="The menu's name and each site's menu"
          style={{ padding: '9px 12px', fontSize: 13, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0,
            color: tab === 'details' ? 'var(--t1)' : 'var(--t3)', fontWeight: tab === 'details' ? 700 : 500, borderBottom: `2.5px solid ${tab === 'details' ? 'var(--acc)' : 'transparent'}`, marginBottom: -1 }}>⚙ Menu details</button>
      </div>

      <StatusBar status={status} canEdit={canEdit}
        onChanges={() => setShowChanges(true)} onPublish={() => { setNote(null); setTab('publish'); }}
        draftId={sets.find((d) => d.status === 'draft')?.id || null}
        onBack={() => setWorkingId(sets.find((d) => d.status === 'draft')?.id || null)} />

      {note && <div style={{ marginBottom: 12, flexShrink: 0 }}><Notice tone={note.tone} onClose={() => setNote(null)} actions={note.actions}>{note.text}</Notice></div>}
      {guide && (tab === 'grid' || tab === 'groups') && <Guide onClose={closeGuide} />}

      {tab === 'grid' && (
        <MsmGrid {...shared}
          onOpenProduct={(id) => setSheet({ productId: id })}
          onAddProduct={() => setSheet({ create: true })}
          onChangePrices={(scope) => setTool(scope || { all: true })}
          onCsv={(kind) => setCsv(kind)} />
      )}
      {tab === 'groups' && <MsmGroups {...shared} pick={groupPick} onPick={setGroupPick} onChangePrices={(scope) => setTool(scope)} />}
      {tab === 'details' && <MsmDetails {...shared} />}
      {extra && extra.render(shared)}

      {sheet && (
        <MsmProductSheet key={sheet.productId || 'new'} {...shared} productId={sheet.productId || null} create={!!sheet.create}
          onClose={() => setSheet(null)} onCreated={(id) => setSheet({ productId: id })} />
      )}
      {tool && <MsmChangePrices {...shared} initialScope={tool} onClose={() => setTool(null)} />}
      {showChanges && <MsmChangesPanel {...shared} onClose={() => setShowChanges(false)} />}
      {csv && <MsmCsv key={csv} initial={csv} {...shared} onClose={() => setCsv(null)} />}
    </div>
  );
}

// "Mon 1 Dec 06:00" from a scheduled push's time on the site clock (a wall clock time, no zone).
function runWords(runLocal) {
  if (!runLocal) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(runLocal));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${m[4]}:${m[5]}`;
}

// Live menu, a draft, or a scheduled push being looked at: said in one strip, always (design 2, item 1).
function StatusBar({ status, canEdit, onChanges, onPublish, onBack, draftId = null }) {
  const tones = {
    good: { bar: 'var(--acc)', bg: 'var(--acc-d)' },
    warn: { bar: 'var(--amber, #F5A623)', bg: 'color-mix(in srgb, var(--amber, #F5A623) 11%, transparent)' },
    info: { bar: 'var(--blu, #4A8CFF)', bg: 'var(--blu-d, var(--bg2))' },
  };
  const t = tones[status.tone] || tones.good;
  return (
    <div role="status" data-testid="msm-status-bar" data-state={status.state}
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderRadius: 10, background: t.bg, borderLeft: `4px solid ${t.bar}`, marginBottom: 12, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: t.bar, flexShrink: 0 }} />
      <span style={{ fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap' }}>{status.title}</span>
      <span style={{ fontSize: 13, color: 'var(--t2)', flex: '1 1 260px', minWidth: 0 }}>{status.words}</span>
      {status.state === 'draft' && (
        <>
          <Btn small kind="soft" onClick={onChanges}>See the changes</Btn>
          {canEdit && <Btn small kind="primary" disabled={!status.count} onClick={onPublish} title={status.count ? undefined : 'Make a change first'}>Review and publish</Btn>}
        </>
      )}
      {status.state === 'scheduled' && <Btn small kind="primary" onClick={onBack}>{draftId ? 'Back to your draft' : 'Back to the live menu'}</Btn>}
      {status.state === 'live' && status.draftId && <Btn small kind="primary" onClick={onBack}>Back to your draft</Btn>}
    </div>
  );
}

// The first run guide (design 6.7): four steps, closed once and remembered.
function Guide({ onClose }) {
  return (
    <div data-testid="msm-guide" style={{ ...ui.card, padding: '14px 16px', marginBottom: 12, flexShrink: 0, background: 'linear-gradient(135deg, var(--acc-d), var(--bg1) 70%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>How the group menu works</div>
        <Btn small kind="primary" onClick={onClose}>Got it</Btn>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {GUIDE_STEPS.map((st) => (
          <div key={st.n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ width: 24, height: 24, borderRadius: 12, background: 'var(--acc)', color: '#0b0c10', fontSize: 12.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{st.n}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 750 }}>{st.title}</div>
              <div style={{ ...ui.sub, fontSize: 12 }}>{st.words}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Header({ menu, sites, children, onGuide = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: 'var(--t4)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>Multi site menu<BetaTag /></div>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.6px', margin: '4px 0 2px', color: 'var(--t1)' }}>{menu?.name || 'Group menu'}</h1>
        {menu && (
          <div style={ui.sub}>
            {sites?.length || 0} site{sites?.length === 1 ? '' : 's'}
            {menu.last_published_at ? ` · last published ${new Date(menu.last_published_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${menu.last_published_by ? ` by ${menu.last_published_by}` : ''}` : ''}
            {onGuide && <> · <Btn small kind="link" style={{ padding: 0 }} onClick={onGuide}>How this works</Btn></>}
          </div>
        )}
      </div>
      {children && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

// "Your changes go into": which draft the edits land in, or a scheduled push to look at as it
// will be. Shown only when there is a choice (two drafts, or a scheduled push): one draft at a
// time is the normal case (design 2, item 3).
function WorkingOn({ sets, working, counted, canEdit, api, menu, onPick, onSets, onNote }) {
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
      <span style={{ ...ui.sub, whiteSpace: 'nowrap' }}>Your changes go into:</span>
      <select aria-label="Your changes go into" style={{ ...ui.input, width: 'auto', minWidth: 220, maxWidth: 320 }} value={working?.id || ''} onChange={(e) => { if (e.target.value === '__new') setNaming({ id: null, title: '' }); else onPick(e.target.value || null); }}>
        <option value="">Live menu (your next change starts a draft)</option>
        {drafts.map((d) => <option key={d.id} value={d.id}>Draft: {d.title}{d.id === working?.id ? ` (${counted?.total ? counted.words : 'empty'})` : ''}</option>)}
        {others.map((d) => <option key={d.id} value={d.id}>{d.status === 'scheduled' ? 'Scheduled' : 'Publishing'}: {d.title} (read only)</option>)}
        {canEdit && <option value="__new">+ Start another draft…</option>}
      </select>
      {canEdit && working?.status === 'draft' && <Btn small kind="link" onClick={() => setNaming({ id: working.id, title: working.title })}>Rename</Btn>}
      {working && <Pill tone={working.status === 'draft' ? 'warn' : 'blue'}>{working.status === 'draft' ? 'Draft' : 'Read only'}</Pill>}
    </div>
  );
}
