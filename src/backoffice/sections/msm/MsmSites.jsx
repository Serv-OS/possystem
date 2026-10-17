// src/backoffice/sections/msm/MsmSites.jsx
//
// MULTI SITE MENU (v5.11.75): the Sites tab. A card per site saying what it is doing: In sync,
// Changes waiting (the draft reaches it), Scheduled (next at), Running, Will fail (the pre check an
// hour before found a problem), Failed (Retry), Late, or Changed at the venue (Review). Plus:
//   * Check the sites: reads every site's rows and lists what was changed there by hand since the
//     last publish (msmDiff.siteDrift, kept values respected), with "Keep the venue's" (stages the
//     venue's values into the draft as that site's own) for the ones ticked. Products a site has
//     of its own are counted, never touched.
//   * Add a site (design 4e): a venue of the company not in the group menu yet, every product at the
//     group price or copied from a chosen site, in a new draft that opens in Publish for the preview.

import { useEffect, useMemo, useState } from 'react';
import { sitesReached, siteDrift, keepVenueChanges } from '../../../../supabase/functions/_shared/msmDiff.js';
import { planAddSite } from '../../../../supabase/functions/_shared/msmSites.js';
import { whenText } from '../../../../supabase/functions/_shared/msmSchedule.js';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';
import { siteCards, sitesToAdd } from '../../../lib/msm/msmPublishView';
import { venueMenuChoices } from '../../../lib/msm/msmImportReview';
import { Btn, Pill, Notice, Modal, Sheet, Segmented, Field } from './msmUi';
import { ui } from './msmStyle';
import { useMsmHistory } from './useMsmHistory';

export default function MsmSites({ api, client, menu, live, eff, sites, rows, canEdit, editable, stage, setWorkingId, setNote, setTab, refreshSets, reload }) {
  const history = useMsmHistory(api, menu?.id, { every: 20000, onSettled: () => { reload(); refreshSets(); } });
  const [check, setCheck] = useState(null);         // { at, drift: { loc: [lines] }, own: { loc: n }, failed: [] }
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState(null);       // locationId
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');

  const names = useMemo(() => Object.fromEntries((live?.products || []).map((p) => [p.id, p.menu_name || p.name])), [live]);
  const waiting = useMemo(() => new Set(eff && rows.length ? sitesReached(eff, rows) : []), [eff, rows]);
  const driftCount = useMemo(() => Object.fromEntries(Object.entries(check?.drift || {}).map(([k, v]) => [k, v.length])), [check]);
  const cards = useMemo(() => siteCards(sites, history.rows || [], { waiting, drift: driftCount }), [sites, history.rows, waiting, driftCount]);
  const onSale = useMemo(() => {
    const m = new Map();
    for (const ps of eff?.productSites || []) if (ps.active !== false) m.set(ps.location_id, (m.get(ps.location_id) || 0) + 1);
    return m;
  }, [eff]);

  const runCheck = async () => {
    setChecking(true);
    const r = await api.venues(sites.map((s) => s.id));
    const drift = {}, own = {};
    for (const s of sites) {
      const raw = r.venues[s.id];
      if (!raw) continue;
      drift[s.id] = siteDrift(live, s.id, raw, names);
      const managed = new Set((live?.productSites || []).filter((ps) => ps.location_id === s.id).map((ps) => ps.venue_item_id));
      own[s.id] = (raw.items || []).filter((i) => !managed.has(i.id) && i.archived !== true).length;
    }
    setCheck({ at: Date.now(), drift, own, failed: r.failed });
    setChecking(false);
  };

  const retry = async (card) => {
    setBusy(card.id);
    const r = await api.retrySite(card.failed.versionId, card.id);
    setBusy('');
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setNote({ tone: 'good', text: `${card.name} is being tried again, with the group menu as it is now.` });
    await history.refresh();
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ ...ui.row, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Sites</div>
          <div style={ui.sub}>
            {check ? `Checked ${new Date(check.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. ` : ''}
            Each site sells from its own copy of the menu; publishing writes the group's changes into it.
          </div>
        </div>
        <Btn kind="soft" disabled={checking} onClick={runCheck}>{checking ? 'Reading every site…' : 'Check the sites for changes made there'}</Btn>
        {canEdit && <Btn kind="primary" onClick={() => setAdding(true)}>Add a site</Btn>}
      </div>
      {history.error && <Notice tone="bad">{history.error}</Notice>}
      {check?.failed?.length > 0 && <Notice tone="bad">Could not read {check.failed.map((l) => sites.find((s) => s.id === l)?.name || 'one site').join(', ')}.</Notice>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <div key={c.id} style={{ ...ui.card, padding: 16, borderColor: c.tone === 'bad' ? 'var(--red-b)' : 'var(--bdr)' }}>
            <div style={{ ...ui.row, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 750 }}>{c.name}</div>
                <div style={ui.sub}>{onSale.get(c.id) || 0} products on sale{check?.own?.[c.id] ? ` · ${check.own[c.id]} of its own, not managed here` : ''}</div>
              </div>
              <Pill tone={c.tone}>{c.label}</Pill>
            </div>
            {c.flags.length > 1 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                {c.flags.slice(1).map((f) => <Pill key={f.state} tone={f.tone}>{f.label}</Pill>)}
              </div>
            )}
            <div style={{ display: 'grid', gap: 4, marginTop: 10, fontSize: 12.5, color: 'var(--t2)' }}>
              {c.nextAt != null && <div>Next update starts {whenText(c.nextAt, c.timezone)}</div>}
              {c.willFailWords && <div style={{ color: 'var(--red)' }}>Will fail: {c.willFailWords}</div>}
              {c.failed && <div style={{ color: 'var(--red)' }}>{c.failed.title ? `"${c.failed.title}" ` : ''}failed: {c.failed.error}</div>}
              {c.lastDoneAt != null && <div style={{ color: 'var(--t3)' }}>Last updated {new Date(c.lastDoneAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{c.lastVersionNo ? ` (version ${c.lastVersionNo})` : ''}</div>}
              {c.drift > 0 && <div>{c.drift} thing{c.drift === 1 ? ' was' : 's were'} changed at the venue since the last publish</div>}
            </div>
            <div style={{ ...ui.row, marginTop: 12, flexWrap: 'wrap' }}>
              {canEdit && c.failed && <Btn small kind="primary" disabled={busy === c.id} onClick={() => retry(c)}>Retry {c.name}</Btn>}
              {c.drift > 0 && <Btn small kind="soft" onClick={() => setReview(c.id)}>Review</Btn>}
              {waiting.has(c.id) && <Btn small kind="link" onClick={() => setTab('publish')}>See what changes</Btn>}
            </div>
          </div>
        ))}
      </div>

      {review && (
        <DriftReview site={sites.find((s) => s.id === review)} lines={check?.drift?.[review] || []} live={live} editable={editable} stage={stage}
          onClose={() => setReview(null)} />
      )}
      {adding && (
        <AddSite api={api} client={client} menu={menu} live={live} sites={sites} setNote={setNote}
          onClose={() => setAdding(false)}
          onStaged={async (setId) => { setAdding(false); await refreshSets(); setWorkingId(setId); setTab('publish'); }} />
      )}
    </div>
  );
}

// What a venue changed by hand: tick the ones to keep as that site's own.
function DriftReview({ site, lines, live, editable, stage, onClose }) {
  const [ticked, setTicked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const toggle = (i) => setTicked((t) => { const n = new Set(t); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const keep = async () => {
    const picked = lines.filter((_, i) => ticked.has(i));
    if (!picked.length) return;
    setSaving(true);
    const r = await stage(keepVenueChanges(live, site.id, picked), { done: `${picked.length} of ${site.name}'s own value${picked.length === 1 ? ' is' : 's are'} in the draft. Publish it to make it stick.` });
    setSaving(false);
    if (r?.ok) onClose();
  };
  return (
    <Sheet title={`Changed at ${site?.name || 'the site'}`} width={600} onClose={onClose}
      sub="Changed by hand at the site since the last publish. Keep the site's value, or leave it: the next publish that changes that product puts the group's value back."
      footer={(
        <>
          <Btn small kind="soft" onClick={() => setTicked(new Set(lines.map((_, i) => i)))}>Tick all</Btn>
          <div style={{ flex: 1 }} />
          {editable && <Btn kind="primary" disabled={saving || !ticked.size} onClick={keep}>Keep the site's for {ticked.size} ticked</Btn>}
        </>
      )}>
      {!lines.length && <Notice tone="good">Nothing was changed at this site.</Notice>}
      {lines.map((l, i) => (
        <label key={`${l.venueItemId}|${l.column}`} style={{ ...ui.row, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={ticked.has(i)} onChange={() => toggle(i)} style={{ marginTop: 3 }} />
          <span>{l.words}</span>
        </label>
      ))}
    </Sheet>
  );
}

// Add a site: pick the venue, which of its menus to write into (or a new one), and the prices.
function AddSite({ api, client, menu, live, sites, setNote, onClose, onStaged }) {
  const [company, setCompany] = useState(null);
  const [loc, setLoc] = useState('');
  const [rawBy, setRawBy] = useState({});             // loc -> raw venue | 'error'
  const [menuPick, setMenuPick] = useState({});       // loc -> venue menu id ('' = make a new one)
  const [prices, setPrices] = useState('default');
  const [copyFrom, setCopyFrom] = useState(sites[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState('');

  useEffect(() => {
    let on = true;
    readAllRows(() => client.from('locations').select('id,name,timezone,org_id').eq('org_id', menu.org_id).order('name').order('id')).then((r) => {
      if (!on) return;
      if (!r.rows) { setWords('Could not read the company\'s sites.'); setCompany([]); return; }
      const free = sitesToAdd(r.rows, live);
      setCompany(free);
      if (free.length) setLoc(free[0].id);
    });
    return () => { on = false; };
  }, [client, menu, live]);

  useEffect(() => {
    let on = true;
    if (!loc || rawBy[loc]) return undefined;
    api.venue(loc).then((r) => { if (on) setRawBy((m) => ({ ...m, [loc]: r.ok ? r : 'error' })); });
    return () => { on = false; };
  }, [api, loc, rawBy]);
  const raw = loc ? rawBy[loc] || null : null;
  const venueMenuId = menuPick[loc] || '';
  const setVenueMenuId = (id) => setMenuPick((m) => ({ ...m, [loc]: id }));

  const menus = raw && raw !== 'error' ? venueMenuChoices(raw) : [];
  const site = (company || []).find((s) => s.id === loc);
  const plan = useMemo(() => (loc ? planAddSite(live, { locationId: loc, venueMenuId: venueMenuId || null, prices, copyFrom }) : null), [live, loc, venueMenuId, prices, copyFrom]);

  const go = async () => {
    if (!plan?.count) return;
    setBusy(true);
    const d = await api.createDraft(menu.id, `Add ${site?.name || 'a site'}`.slice(0, 80), 'add_site');
    if (!d.ok) { setBusy(false); setNote({ tone: 'bad', text: d.words }); return; }
    const r = await api.stageMany(d.data.id, plan.changes, []);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: `The draft was made but ${r.failed.length || r.conflicts} change${(r.failed.length || r.conflicts) === 1 ? '' : 's'} did not go in: ${r.failed[0]?.words || 'try again'}.` }); }
    else setNote({ tone: 'good', text: `${site?.name || 'The site'} is in a draft with ${plan.count} products. Check the preview, then publish or schedule it for opening day.` });
    onStaged(d.data.id);
  };

  return (
    <Modal title="Add a site" sub="A new site gets the whole group menu in minutes. Nothing reaches it until you publish." width={640} onClose={onClose}
      footer={(
        <>
          <div style={{ flex: 1, ...ui.sub }}>{plan?.count ? `${plan.words}.` : ''}</div>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={busy || !plan?.count || raw === null || raw === 'error'} onClick={go}>Put it in a new draft</Btn>
        </>
      )}>
      {words && <Notice tone="bad">{words}</Notice>}
      {company === null && <div style={ui.sub}>Reading the company's sites…</div>}
      {company && !company.length && <Notice>Every site of the company is already in the group menu.</Notice>}
      {company && company.length > 0 && (
        <>
          <Field label="Site">
            <select aria-label="Site" style={ui.input} value={loc} onChange={(e) => setLoc(e.target.value)}>
              {company.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Its menu" hint={menus.length ? 'Products the site already sells stay as they are; the group\'s products go in beside them.' : 'This site has no menu yet: one is made when you publish.'}>
            {raw === null && <div style={ui.sub}>Reading the site…</div>}
            {raw === 'error' && <Notice tone="bad">Could not read this site.</Notice>}
            {raw && raw !== 'error' && (
              <select aria-label="Its menu" style={ui.input} value={venueMenuId} onChange={(e) => setVenueMenuId(e.target.value)}>
                <option value="">Make a new menu called "{menu.name}"</option>
                {menus.map((m) => <option key={m.id} value={m.id}>Write into its menu "{m.name}" ({m.products} products)</option>)}
              </select>
            )}
          </Field>
          <Field label="Prices">
            <Segmented value={prices} onChange={setPrices} options={[{ value: 'default', label: 'The group prices' }, { value: 'copy', label: 'Copy from a site' }]} />
            {prices === 'copy' && (
              <select aria-label="Copy prices from" style={{ ...ui.input, marginTop: 8 }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name} (what it sells, at its prices)</option>)}
              </select>
            )}
          </Field>
          <div style={{ ...ui.sub, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)' }}>
            Publishing makes the site's menu, its categories, the modifier groups and every product, with VAT matched by name and rate.
            Set up its printers and kitchen screens in its own Back Office before it opens. You can schedule it for opening morning.
          </div>
        </>
      )}
    </Modal>
  );
}
