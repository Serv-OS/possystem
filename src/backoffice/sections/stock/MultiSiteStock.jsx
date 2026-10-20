// src/backoffice/sections/stock/MultiSiteStock.jsx
//
// MULTI SITE STOCK, Phase 1 (v5.11.80): head office's Shared stock screen, beside the Multi site
// menu. Plan (18 Oct 2026) 4.1 to 4.3, 4.9 to 4.11, 5.2, 6.2: head office owns the DEFINITIONS
// (stock items, packs, unit bridges, suppliers, supplier prices); each site keeps its FACTS (on hand,
// cost, ledger, pars, areas, counts, orders, invoices, waste, production, preferred supplier).
//
// Opened only by the stock Editors and Viewers ServOS added by name, while the company has Shared
// stock AND the Multi site menu on (BackOfficeApp's route gate; the database checks every call).
// Every edit goes into the company's draft (msm_stock_changes); nothing changes at any site until an
// Editor publishes, at 05:00 on each site's clock by default or now. History keeps every version and
// the newest one can be undone. The menu's own drafts, publish and Undo are a separate thing.

import { useCallback, useEffect, useState } from 'react';
import { isMock } from '../../../lib/supabase';
import { stockCompanyApi } from '../../../lib/stock/company/stockCompanyApi';
import BetaTag from '../../../components/BetaTag';
import { Btn, Notice, Segmented } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';
import MssItems from './MssItems';
import MssSuppliers from './MssSuppliers';
import MssChanges from './MssChanges';
import MssHistory from './MssHistory';
import MssSetup from './MssSetup';

const TABS = [
  { value: 'items', label: 'Stock items' },
  { value: 'suppliers', label: 'Suppliers and prices' },
  { value: 'changes', label: 'Review and publish' },
  { value: 'history', label: 'History' },
  { value: 'setup', label: 'Set up' },
];
const TAB_KEY = 'mss-last-tab';
const readTab = () => { try { const v = localStorage.getItem(TAB_KEY); return TABS.some((x) => x.value === v) ? v : 'items'; } catch { return 'items'; } };
const saveTab = (v) => { try { localStorage.setItem(TAB_KEY, v); } catch { /* private mode */ } };

export default function MultiSiteStock({ access, onAccessLost }) {
  const api = stockCompanyApi;
  const orgId = access?.orgId || null;
  const canEdit = !!access?.canEdit;
  const [tab, setTabState] = useState(readTab);
  const setTab = useCallback((v) => { setTabState(v); saveTab(v); }, []);
  const [sites, setSites] = useState([]);
  const [draft, setDraft] = useState([]);
  const [draftErr, setDraftErr] = useState('');
  const [note, setNote] = useState(null);           // { tone, text, actions }
  const [phase, setPhase] = useState('loading');    // loading | ready | missing | error
  const [reload, setReload] = useState(0);
  const bump = useCallback(() => setReload((n) => n + 1), []);

  const refreshDraft = useCallback(async () => {
    if (!orgId) return null;
    const r = await api.draft(orgId);
    if (r.ok) { setDraft(r.data || []); setDraftErr(''); } else setDraftErr(r.words);
    return r;
  }, [api, orgId]);

  useEffect(() => {
    if (!orgId || isMock) return undefined;
    let live = true;
    (async () => {
      const r = await api.itemsPage(orgId, { limit: 1 });
      if (!live) return;
      if (!r.ok) {
        if (r.notInstalled) { setPhase('missing'); return; }
        if (/Only people ServOS added|Sign in/i.test(r.words)) { onAccessLost?.(); }
        setPhase('error'); setNote({ tone: 'bad', text: r.words }); return;
      }
      setSites(Array.isArray(r.data?.sites) ? r.data.sites : []);
      setPhase('ready');
      refreshDraft();
    })();
    return () => { live = false; };
  }, [api, orgId, reload, refreshDraft, onAccessLost]);

  // Every edit lands in the draft through here; the draft is read back before it shows as staged.
  const stage = useCallback(async (changes, words) => {
    if (!canEdit) { setNote({ tone: 'bad', text: 'Only stock Editors can change company stock.' }); return { ok: false }; }
    const r = await api.stage(orgId, changes);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return r; }
    await refreshDraft();
    setNote({ tone: 'good', text: words || 'Added to the draft. Nothing changes at any site until you publish.',
      actions: [{ label: 'Review and publish', onClick: () => setTab('changes') }] });
    return r;
  }, [api, orgId, canEdit, refreshDraft, setTab]);

  if (isMock) {
    return <div style={ui.page}><div style={ui.card}>Shared stock needs the live database: it is not part of the demo screens.</div></div>;
  }
  if (!orgId) return <div style={ui.page}><div style={ui.card}>This login is not a stock Editor or Viewer of a company.</div></div>;

  const shared = { api, orgId, canEdit, sites, draft, draftErr, refreshDraft, stage, setNote, setTab, bump, reload };
  return (
    <div style={ui.page}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Multi site stock</h1><BetaTag />
        <span style={{ ...ui.sub, marginLeft: 6 }}>{access?.orgName || ''}{canEdit ? '' : ' · you can look, not change'}</span>
      </div>
      <div style={{ ...ui.sub, marginBottom: 14 }}>
        Head office owns the stock items, packs, suppliers and prices. Each site keeps its own stock on hand, cost, pars, areas, counts, orders and waste:
        publishing never changes those.
      </div>
      <div style={{ ...ui.row, marginBottom: 12, flexWrap: 'wrap' }}>
        <Segmented value={tab} onChange={setTab} options={TABS.map((x) => (x.value === 'changes' && draft.length ? { ...x, label: `${x.label} (${draft.length})` } : x))} />
        <span style={{ flex: 1 }} />
        <Btn small onClick={bump}>Refresh</Btn>
      </div>
      {draft.length > 0 && tab !== 'changes' && (
        <div style={{ marginBottom: 10 }}>
          <Notice tone="info" actions={[{ label: 'Review and publish', onClick: () => setTab('changes') }]}>
            {draft.length} change{draft.length === 1 ? '' : 's'} in the draft, not at any site yet.
          </Notice>
        </div>
      )}
      {draftErr && <div style={{ marginBottom: 10 }}><Notice tone="bad">Could not read the draft: {draftErr}</Notice></div>}
      {note && <div style={{ marginBottom: 10 }}><Notice tone={note.tone} actions={note.actions} onClose={() => setNote(null)}>{note.text}</Notice></div>}
      {phase === 'loading' && <div style={ui.sub}>Loading…</div>}
      {phase === 'missing' && <div style={ui.card}>Not installed yet: it appears once the database update for multi site stock (20261019c) has been run.</div>}
      {phase === 'ready' && (
        <>
          {tab === 'items' && <MssItems {...shared} />}
          {tab === 'suppliers' && <MssSuppliers {...shared} />}
          {tab === 'changes' && <MssChanges {...shared} />}
          {tab === 'history' && <MssHistory {...shared} />}
          {tab === 'setup' && <MssSetup {...shared} />}
        </>
      )}
    </div>
  );
}
