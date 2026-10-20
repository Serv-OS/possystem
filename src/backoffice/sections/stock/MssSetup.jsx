// src/backoffice/sections/stock/MssSetup.jsx
//
// MULTI SITE STOCK (v5.11.80): Set up (plan 6.2, 7 "Coffee Boy go live order").
//   1. Add the usual six areas at sites (areas go first: a new item lands in its usual area).
//   2. Start from a site: that site's rows become the company list (no quantity, cost or name
//      changes; the self check must plan zero writes, or nothing is kept).
//   3. Link site items: a site's own rows that look like company rows join them only when ticked.
//   4. Switch everything on at every site, or make a site the same as another.
//   5. Import a CSV of items, packs or prices into the draft (checked first, row by row).
//   Add a site (round 1): a site new to the company in one step: the usual six areas now, and it
//   stocks exactly what a chosen site stocks from the next publish.

import { useState } from 'react';
import { Btn, Notice, SiteChecklist, Segmented, ConfirmDialog } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';
import { parseCsv, csvRowsFor, CSV_COLUMNS, newId } from '../../../lib/stock/company/stockCompanyRules';
import { t } from './mssShared';
import { SiteSelect } from './mssCommon';

export default function MssSetup({ api, orgId, canEdit, sites, setNote, refreshDraft, bump, setTab }) {
  const [areaSites, setAreaSites] = useState([]);
  const [startSite, setStartSite] = useState(null);
  const [asking, setAsking] = useState(null);
  const [linkSite, setLinkSite] = useState(null);
  const [cands, setCands] = useState(null);
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newSite, setNewSite] = useState(null);
  const [likeSite, setLikeSite] = useState(null);
  const say = (r, good) => { if (!r.ok) setNote({ tone: 'bad', text: r.words }); else setNote({ tone: 'good', text: good(r.data) }); return r.ok; };

  const addAreas = async () => {
    setBusy(true);
    const r = await api.addAreas(orgId, areaSites.length ? areaSites : null);
    setBusy(false);
    say(r, (d) => (d.added ? `${d.added} areas added. Sites that had an area of that kind kept theirs.` : 'Every chosen site has the usual six already.'));
  };
  const start = async () => {
    setAsking(null); setBusy(true);
    const r = await api.startFromSite(orgId, startSite);
    setBusy(false);
    if (say(r, (d) => `${sites.find((s) => s.id === startSite)?.name}: ${d.items} items, ${d.packs} packs, ${d.bridges} unit bridges, ${d.suppliers} suppliers and ${d.prices} prices are now the company list. Nothing at the site changed (the self check planned 0 writes).`)) bump();
  };
  const loadCands = async (loc) => {
    setLinkSite(loc); setCands(null);
    if (!loc) return;
    const r = await api.linkCandidates(orgId, loc);
    if (r.ok) setCands(r.data); else setNote({ tone: 'bad', text: r.words });
  };
  const tickAll = async () => {
    setBusy(true);
    const r = await api.stageLinks(orgId, linkSite);
    setBusy(false);
    if (say(r, (d) => `${d.staged || 0} links ticked in the draft. Publish to make them company rows there; nothing changes at the site until then.`)) { refreshDraft(); loadCands(linkSite); }
  };
  const everySite = async () => {
    setAsking(null); setBusy(true);
    const r = await api.stageSites(orgId, { items: null, sites: null, on: true, withSuppliers: true });
    setBusy(false);
    if (say(r, (d) => `Every company item and its suppliers are on at every site, in the draft (${d.staged} changes).`)) refreshDraft();
  };
  const copy = async () => {
    setBusy(true);
    const r = await api.copySites(orgId, from, to);
    setBusy(false);
    if (say(r, (d) => `${d.staged} changes in the draft: ${sites.find((s) => s.id === to)?.name} will stock what ${sites.find((s) => s.id === from)?.name} stocks.`)) refreshDraft();
  };

  const addSite = async () => {
    setBusy(true);
    const a = await api.addAreas(orgId, [newSite]);
    if (!a.ok) { setBusy(false); setNote({ tone: 'bad', text: a.words }); return; }
    const c = await api.copySites(orgId, likeSite, newSite);
    setBusy(false);
    const n = sites.find((x) => x.id === newSite)?.name; const l = sites.find((x) => x.id === likeSite)?.name;
    if (say(c, (d) => `${n}: ${a.data?.added || 0} areas added now; ${d.staged} changes in the draft so it stocks exactly what ${l} stocks. Publish, then count each item there once (an Opening count).`)) refreshDraft();
  };

  if (!canEdit) return <div style={ui.card}>Only stock Editors can set things up.</div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={ui.card}>
        <div style={ui.h2}>Add a site</div>
        <div style={{ ...ui.sub, marginBottom: 10 }}>A site new to the company: the usual six areas now, and it stocks exactly what the site you pick stocks, from the next publish. Its stock starts at 0, so count each item there once (an Opening count).</div>
        <div style={{ ...ui.row, flexWrap: 'wrap', gap: 10 }}>
          <SiteSelect sites={sites} value={newSite} onChange={setNewSite} placeholder="The new site" />
          <SiteSelect sites={sites} value={likeSite} onChange={setLikeSite} placeholder="stocks what this site stocks" />
          <Btn kind="primary" disabled={busy || !newSite || !likeSite || newSite === likeSite} onClick={addSite}>Set it up</Btn>
        </div>
      </div>

      <div style={ui.card}>
        <div style={ui.h2}>1. The usual six areas</div>
        <div style={{ ...ui.sub, marginBottom: 10 }}>Cellar, Walk in fridge, Freezer, Dry store, Bar, Kitchen, at each chosen site that does not have one of that kind. Do this before publishing items: a new item lands in its usual area.</div>
        <SiteChecklist sites={sites} value={areaSites} onChange={setAreaSites} />
        <Btn kind="primary" style={{ marginTop: 10 }} disabled={busy} onClick={addAreas}>{areaSites.length ? `Add at ${areaSites.length} site${areaSites.length === 1 ? '' : 's'}` : 'Add at every site'}</Btn>
      </div>

      <div style={ui.card}>
        <div style={ui.h2}>2. Start from a site</div>
        <div style={{ ...ui.sub, marginBottom: 10 }}>That site's live stock items, packs, unit bridges, suppliers and prices become the company list, and its rows are linked to them. No quantity, cost or name changes there. Works once, on an empty company list. Best outside trading.</div>
        <div style={ui.row}><SiteSelect sites={sites} value={startSite} onChange={setStartSite} /><Btn kind="primary" disabled={!startSite || busy} onClick={() => setAsking('start')}>Start from this site</Btn></div>
      </div>

      <div style={ui.card}>
        <div style={ui.h2}>3. Link a site's own items</div>
        <div style={{ ...ui.sub, marginBottom: 10 }}>A site's own items, suppliers and prices that look like company ones (same SKU and unit, or same name and unit). Nothing links until you tick it; a different unit stays the site's own.</div>
        <div style={ui.row}><SiteSelect sites={sites} value={linkSite} onChange={loadCands} />{cands && <Btn kind="primary" disabled={busy} onClick={tickAll}>Tick every one with a single match</Btn>}</div>
        {cands && (
          <div style={{ marginTop: 10 }}>
            <div style={ui.sub}>{cands.items_total || 0} items, {(cands.suppliers || []).length} suppliers, {cands.prices_total || 0} prices, {(cands.packs || []).length} packs could link.</div>
            <table style={{ ...t.table, marginTop: 6 }}>
              <thead><tr><th style={t.th}>Company</th><th style={t.th}>The site's own</th><th style={t.th}>Why</th><th style={t.th} /></tr></thead>
              <tbody>
                {[...(cands.items || []), ...(cands.suppliers || [])].slice(0, 200).map((c) => (
                  <tr key={`${c.company_id}-${c.venue_id}`}>
                    <td style={t.td}>{c.company_name}</td><td style={t.td}>{c.venue_name}</td><td style={{ ...t.td, ...t.grey }}>{c.why}</td>
                    <td style={{ ...t.td, ...t.grey }}>{Number(c.choices) > 1 || Number(c.venue_choices) > 1 ? 'more than one match: pick on the item' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={ui.card}>
        <div style={ui.h2}>4. Which sites stock what</div>
        <div style={{ ...ui.sub, marginBottom: 10 }}>A new company item is off everywhere until you switch it on. Switch everything on everywhere, or make one site stock what another stocks.</div>
        <div style={{ ...ui.row, flexWrap: 'wrap', gap: 10 }}>
          <Btn disabled={busy} onClick={() => setAsking('every')}>Everything on at every site</Btn>
          <span style={ui.sub}>or</span>
          <SiteSelect sites={sites} value={to} onChange={setTo} placeholder="Make this site" />
          <SiteSelect sites={sites} value={from} onChange={setFrom} placeholder="the same as" />
          <Btn disabled={busy || !from || !to || from === to} onClick={copy}>Stage it</Btn>
        </div>
      </div>

      <CsvImport api={api} orgId={orgId} setNote={setNote} refreshDraft={refreshDraft} setTab={setTab} />

      {asking === 'start' && <ConfirmDialog title={`Start from ${sites.find((s) => s.id === startSite)?.name}?`} yes="Start" onNo={() => setAsking(null)} onYes={start}
        words="Its live stock rows become the company list and are linked to it. Nothing at that site changes: no quantity, cost or name. If anything would change, nothing is kept. History can undo it." />}
      {asking === 'every' && <ConfirmDialog title="Everything on at every site?" yes="Stage it" onNo={() => setAsking(null)} onYes={everySite}
        words="Every company item and its suppliers go on at every site, in the draft. Sites get the new items when you publish; each needs an opening count." />}
    </div>
  );
}

function CsvImport({ api, orgId, setNote, refreshDraft, setTab }) {
  const [kind, setKind] = useState('items');
  const [parsed, setParsed] = useState(null);    // { name, rows, missing, unknown }
  const [check, setCheck] = useState(null);      // the import's own check
  const [importId, setImportId] = useState(null);
  const [busy, setBusy] = useState(false);
  const read = async (file) => {
    setCheck(null); setImportId(null);
    if (!file) { setParsed(null); return; }
    const text = await file.text();
    setParsed({ name: file.name, ...csvRowsFor(kind, parseCsv(text)) });
  };
  const runCheck = async () => {
    setBusy(true);
    const id = newId();
    const up = await api.importRows(orgId, id, kind, parsed.rows);
    if (!up.ok) { setBusy(false); setNote({ tone: 'bad', text: up.words }); return; }
    const r = await api.importCommit(orgId, id, true);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setImportId(id); setCheck(r.data);
  };
  const commit = async () => {
    setBusy(true);
    const r = await api.importCommit(orgId, importId, false);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setNote({ tone: 'good', text: `${r.data.staged} rows from ${parsed.name} are in the draft.`, actions: [{ label: 'Review and publish', onClick: () => setTab('changes') }] });
    setParsed(null); setCheck(null); setImportId(null); refreshDraft();
  };
  const spec = CSV_COLUMNS[kind];
  return (
    <div style={ui.card}>
      <div style={ui.h2}>5. Import a CSV</div>
      <div style={{ ...ui.sub, marginBottom: 10 }}>Headings in the first row. Needed: {spec.required.join(', ')}. Also read: {spec.fields.filter((f) => !spec.required.includes(f)).join(', ')}. Items and packs match by SKU, then exact name; prices by supplier, item and supplier SKU. Everything goes into the draft first.</div>
      <div style={{ ...ui.row, flexWrap: 'wrap' }}>
        <Segmented small value={kind} onChange={(v) => { setKind(v); setParsed(null); setCheck(null); }} options={[{ value: 'items', label: 'Items' }, { value: 'packs', label: 'Packs' }, { value: 'prices', label: 'Prices' }]} />
        <input type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} />
      </div>
      {parsed && (
        <div style={{ marginTop: 10 }}>
          {parsed.missing.length > 0 && <Notice tone="bad">Missing headings: {parsed.missing.join(', ')}.</Notice>}
          {parsed.unknown.length > 0 && <div style={t.grey}>Not read: {parsed.unknown.join(', ')}</div>}
          <div style={{ ...ui.sub, margin: '6px 0' }}>{parsed.rows.length} rows read from {parsed.name}.</div>
          {!parsed.missing.length && parsed.rows.length > 0 && <Btn disabled={busy} onClick={runCheck}>{busy ? 'Checking…' : 'Check the rows'}</Btn>}
        </div>
      )}
      {check && (
        <div style={{ marginTop: 10 }}>
          {check.error_count > 0
            ? <Notice tone="bad">{check.error_count} row{check.error_count === 1 ? '' : 's'} cannot go in. Fix the file and check again.<div style={{ marginTop: 6 }}>{(check.errors || []).slice(0, 20).map((e) => <div key={e.row}>Row {e.row + 1}: {e.error}</div>)}</div></Notice>
            : <Notice tone="good" actions={[{ label: busy ? 'Working…' : 'Put them in the draft', onClick: commit, disabled: busy, kind: 'primary' }]}>
                Every row is fine: {check.new} new, {check.updates} changes to existing company rows.</Notice>}
        </div>
      )}
    </div>
  );
}
