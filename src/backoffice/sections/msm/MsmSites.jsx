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
//
// ROUND 2, builder 3 (design 3.1, 3.3 and 2 items 20 and 22):
//   * "Find changes made at sites": each line in words with the site's name, and per line
//     [Keep Leeds's] or [Put the group's back on next publish] (lib/msm/msmDriftView.js).
//   * A site's own products (not in the group menu): "Leeds has 17 products of its own [Look at
//     them]". Each says what it looks like in the group menu; [Link to Latte] or [Bring in as a new
//     product] goes into the draft, worked out so that publishing writes NOTHING at the site
//     (lib/msm/msmBringIn.js). Its option groups come in with it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { sitesReached, siteDrift } from '../../../../supabase/functions/_shared/msmDiff.js';
import { openDrift, driftWords, keepChanges, putBackChanges, bringInOption } from '../../../lib/msm/msmDriftView';
import { ownProducts, bringInChanges, ownCountWords, planJoinSiteAsync, joinableProducts } from '../../../lib/msm/msmBringIn';
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
  const [check, setCheck] = useState(null);         // { at, drift: { loc: [lines] }, own: { loc: n }, raw: { loc: raw }, failed: [] }
  const [bringing, setBringing] = useState(null);   // locationId
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState(null);       // locationId
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');

  const names = useMemo(() => Object.fromEntries([...(live?.products || []), ...(eff?.products || [])].map((p) => [p.id, p.menu_name || p.name]).concat([...(live?.groups || []), ...(eff?.groups || [])].map((g) => [g.id, g.name]))), [live, eff]);
  const waiting = useMemo(() => new Set(eff && rows.length ? sitesReached(eff, rows) : []), [eff, rows]);
  const onSale = useMemo(() => {
    const m = new Map();
    for (const ps of eff?.productSites || []) if (ps.active !== false) m.set(ps.location_id, (m.get(ps.location_id) || 0) + 1);
    return m;
  }, [eff]);

  const runCheck = async () => {
    setChecking(true);
    const r = await api.venues(sites.map((s) => s.id));
    const raw = {};
    for (const s of sites) if (r.venues[s.id]) raw[s.id] = r.venues[s.id];
    setCheck({ at: Date.now(), raw, failed: r.failed });
    setChecking(false);
  };
  // Worked out from the rows read and the group menu as it is now (with the draft), so a line the
  // draft already keeps, or a product already brought in, drops out at once.
  const derived = useMemo(() => {
    const drift = {}, own = {};
    for (const s of sites) {
      const raw = check?.raw?.[s.id];
      if (!raw) continue;
      try { drift[s.id] = openDrift(live, eff, s.id, raw, names); } catch { drift[s.id] = siteDrift(live, s.id, raw, names); }
      try { own[s.id] = ownProducts(eff || live, s.id, raw).filter((o) => !o.archived); } catch { own[s.id] = []; }
    }
    return { drift, own };
  }, [check, sites, live, eff, names]);
  const driftCount = useMemo(() => Object.fromEntries(Object.entries(derived.drift).map(([k, v]) => [k, v.length])), [derived]);
  // Never "In sync" for a site nobody has looked at yet (17 Oct verification).
  const cards = useMemo(() => siteCards(sites, history.rows || [], { waiting, drift: driftCount, checked: !!check }), [sites, history.rows, waiting, driftCount, check]);

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
        <Btn kind="soft" disabled={checking} onClick={runCheck}>{checking ? 'Reading every site…' : 'Find changes made at sites'}</Btn>
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
                <div style={ui.sub}>{onSale.get(c.id) || 0} products on sale</div>
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
              {c.drift > 0 && <div>{c.drift} change{c.drift === 1 ? ' was' : 's were'} made at {c.name} since the last publish</div>}
              {check?.raw?.[c.id] && <div>{ownCountWords((derived.own[c.id] || []).length, c.name)}</div>}
            </div>
            <div style={{ ...ui.row, marginTop: 12, flexWrap: 'wrap' }}>
              {canEdit && c.failed && <Btn small kind="primary" disabled={busy === c.id} onClick={() => retry(c)}>Retry {c.name}</Btn>}
              {c.drift > 0 && <Btn small kind="soft" onClick={() => setReview(c.id)}>Look at the changes</Btn>}
              {(derived.own[c.id] || []).length > 0 && <Btn small kind="soft" onClick={() => setBringing(c.id)}>Look at them</Btn>}
              {waiting.has(c.id) && <Btn small kind="link" onClick={() => setTab('publish')}>See what changes</Btn>}
            </div>
          </div>
        ))}
      </div>

      {review && (
        <DriftReview site={sites.find((s) => s.id === review)} lines={derived.drift[review] || []} central={eff || live} names={names} editable={editable} stage={stage}
          onClose={() => setReview(null)} />
      )}
      {bringing && (
        <BringIn site={sites.find((s) => s.id === bringing)} own={derived.own[bringing] || []} raw={check?.raw?.[bringing]} central={eff || live}
          editable={editable} stage={stage} onClose={() => setBringing(null)} />
      )}
      {adding && (
        <AddSite api={api} client={client} menu={menu} live={live} sites={sites} setNote={setNote}
          onClose={() => setAdding(false)}
          onStaged={async (setId) => { setAdding(false); await refreshSets(); setWorkingId(setId); setTab('publish'); }} />
      )}
    </div>
  );
}

// What a site changed by hand since the last publish: per line, keep the site's value or put the
// group menu's back on the next publish (design 3.3, item 20).
function DriftReview({ site, lines, central, names, editable, stage, onClose }) {
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState(() => new Set());
  const name = site?.name || 'the site';
  const act = async (key, changes, words) => {
    if (!changes.length) return;
    setBusy(key);
    const r = await stage(changes, { done: words });
    setBusy('');
    if (r?.ok) setDone((d) => new Set([...d, key]));
  };
  const keepAll = async () => {
    const all = [];
    for (const l of lines) if (l.kind !== 'unknown_option') all.push(...keepChanges(central, site.id, l));
    await act('all', all, `${name} keeps its own values. They are in the draft, so publishing leaves them as they are.`);
    onClose();
  };
  const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);
  return (
    <Sheet title={`Changes made at ${name}`} width={640} onClose={onClose}
      sub={`Changed by hand at ${name} since the last publish. Keep ${name}'s value, or put the group menu's back on the next publish. A line you leave is overwritten only when a later publish changes that same thing.`}
      footer={(
        <>
          <div style={{ flex: 1 }} />
          {editable && lines.length > 1 && <Btn kind="soft" disabled={!!busy} onClick={keepAll}>Keep all of {name}'s</Btn>}
          <Btn onClick={onClose}>Done</Btn>
        </>
      )}>
      {!lines.length && <Notice tone="good">Nothing was changed at {name}.</Notice>}
      {lines.map((l, i) => {
        const key = `${i}|${l.venueItemId || l.venueGroupId}|${l.column}`;
        const settled = done.has(key);
        return (
          <div key={key} style={{ ...ui.row, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13, opacity: settled ? 0.55 : 1 }}>
            <span style={{ flex: '1 1 240px' }}>{driftWords(l, name, names)}{settled ? ' (in the draft)' : ''}</span>
            {editable && !settled && (l.kind === 'unknown_option'
              ? (
                <>
                  <Btn small kind="soft" disabled={!!busy || !newId()} onClick={() => act(key, bringInOption(central, site.id, l, newId()), `${l.entry?.name || 'The option'} is in the group menu now, on at ${name} with its own id, off at the other sites.`)}>Bring it into the group</Btn>
                  <Btn small kind="link" onClick={() => setDone((d) => new Set([...d, key]))}>Leave it as {name}'s own</Btn>
                </>
              ) : (
                <>
                  <Btn small kind="soft" disabled={!!busy} onClick={() => act(key, keepChanges(central, site.id, l), `${name} keeps its own value. It is in the draft.`)}>Keep {name}'s</Btn>
                  <Btn small kind="link" disabled={!!busy} onClick={() => act(key, putBackChanges(central, site.id, l), `The group menu's value goes back at ${name} on the next publish.`)}>Put the group's back</Btn>
                </>
              ))}
          </div>
        );
      })}
    </Sheet>
  );
}

// A site's own products (design 3.1): what each looks like in the group menu, and the two ways in.
function BringIn({ site, own, raw, central, editable, stage, onClose }) {
  const [pick, setPick] = useState(null);         // { id, linkTo, result }
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const name = site?.name || 'the site';
  const here = new Set((central?.productSites || []).filter((ps) => ps.location_id === site?.id).map((ps) => ps.product_id));
  const linkable = (central?.products || []).filter((p) => !p.archived && !p.parent_product_id && !here.has(p.id))
    .sort((a, b) => String(a.menu_name || a.name).localeCompare(String(b.menu_name || b.name)));
  const list = own.filter((o) => !filter || o.name.toLowerCase().includes(filter.toLowerCase()));
  const work = (o, linkTo) => {
    const result = bringInChanges(central, site.id, raw, o.id, { linkTo: linkTo || null, siteName: name });
    setPick({ id: o.id, linkTo: linkTo || null, result });
  };
  const add = async () => {
    if (!pick?.result?.ok) return;
    setBusy(true);
    const r = await stage(pick.result.changes, { done: pick.result.words.join(' ') });
    setBusy(false);
    if (r?.ok) setPick(null);
  };
  return (
    <Sheet title={`${name}'s own products`} width={680} onClose={onClose}
      sub={`${ownCountWords(own.length, name)} Bring them in so one price change reaches every site. Bringing a product in changes nothing at ${name}: anything ${name} does differently stays ${name}'s own.`}
      footer={<><div style={{ flex: 1 }} /><Btn onClick={onClose}>Done</Btn></>}>
      {own.length > 8 && <input aria-label="Find a product" style={{ ...ui.input, marginBottom: 10 }} placeholder="Find a product" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {!own.length && <Notice tone="good">Every product {name} sells is in the group menu.</Notice>}
      {list.map((o) => {
        const open = pick?.id === o.id;
        return (
          <div key={o.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ ...ui.row, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{o.name}{o.sizes.length ? <span style={{ ...ui.sub, fontWeight: 500 }}> · {o.sizes.length} size{o.sizes.length === 1 ? '' : 's'}</span> : null}</div>
                <div style={ui.sub}>
                  {o.match ? `Looks like ${o.match.name} in the group menu${o.match.how === 'family' ? ' (already shared between sites)' : ' (same name)'}` : 'Not in the group menu'}
                  {o.groups.length ? ` · option groups: ${o.groups.join(', ')}` : ''}
                </div>
              </div>
              {editable && (
                <>
                  {o.match && <Btn small kind="primary" onClick={() => work(o, o.match.productId)}>Link to {o.match.name}</Btn>}
                  <Btn small kind={o.match ? 'soft' : 'primary'} onClick={() => work(o, null)}>Bring in as a new product</Btn>
                  {linkable.length > 0 && (
                    <select aria-label={`Link ${o.name} to another product`} style={{ ...ui.input, width: 'auto', maxWidth: 200, padding: '5px 8px', fontSize: 12.5 }} value=""
                      onChange={(e) => { if (e.target.value) work(o, e.target.value); }}>
                      <option value="">Link to another…</option>
                      {linkable.map((p) => <option key={p.id} value={p.id}>{p.menu_name || p.name}</option>)}
                    </select>
                  )}
                </>
              )}
            </div>
            {open && (
              <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)' }}>
                {pick.result.ok
                  ? <>
                    <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{pick.result.words.map((w) => <li key={w}>{w}</li>)}</ul>
                    <div style={{ ...ui.row }}>
                      <Btn small kind="primary" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add to draft'}</Btn>
                      <Btn small onClick={() => setPick(null)}>Cancel</Btn>
                    </div>
                  </>
                  : <Notice tone="bad">{pick.result.problems.join(' ')}</Notice>}
              </div>
            )}
          </div>
        );
      })}
    </Sheet>
  );
}

// A new id for a group menu row (Bring in makes groups and options it needs).
const newUuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

// Add a site: pick the venue, which of its menus to write into (or a new one), and the prices. A
// site that already sells the group's products joins with them as they are (planJoinSite).
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

  const menus = useMemo(() => (raw && raw !== 'error' ? venueMenuChoices(raw) : []), [raw]);
  const site = (company || []).find((s) => s.id === loc);
  const plan = useMemo(() => (loc ? planAddSite(live, { locationId: loc, venueMenuId: venueMenuId || null, prices, copyFrom }) : null), [live, loc, venueMenuId, prices, copyFrom]);
  // A site that already sells the group's products as its own (the same ids): Add a site would take
  // them over, so it is refused at publish (17 Oct verification).
  const owned = useMemo(() => {
    if (!plan || !raw || raw === 'error') return [];
    const mine = new Map((raw.items || []).map((i) => [i.id, i]));
    return plan.changes.filter((c) => c.target === 'product_site' && mine.has(c.after?.venue_item_id)).map((c) => mine.get(c.after.venue_item_id));
  }, [plan, raw]);
  // Builder B recheck (item 6): such a site was a dead end. It JOINS instead: its own menu, and the
  // group's products it sells linked as they are (Bring in), planned to write nothing there. A site
  // selling the group's products under other ids joins too (a plain Add a site would put a second
  // copy beside each of its own).
  const firstMenu = menus[0]?.id || '';
  const joinMenuId = venueMenuId || firstMenu;
  const joinable = useMemo(() => (raw && raw !== 'error' && joinMenuId ? joinableProducts(live, loc, raw, joinMenuId) : []), [live, loc, raw, joinMenuId]);
  const joining = owned.length > 0 || joinable.length > 0;
  const siteLabel = site?.name || 'This site';
  const orgId = menu?.org_id || null;
  // Worked out on request, a product at a time (some seconds for a big menu), never while drawing.
  const [joinRun, setJoinRun] = useState(null);        // { key, done, total, result }
  const joinKey = `${loc}|${joinMenuId}`;
  const join = joinRun && joinRun.key === joinKey ? joinRun.result : null;
  const working = !!joinRun && joinRun.key === joinKey && !joinRun.result;
  const stopRef = useRef(false);
  useEffect(() => () => { stopRef.current = true; }, []);
  const workOutJoin = async () => {
    if (!raw || raw === 'error' || working) return;
    const key = joinKey;
    stopRef.current = false;
    setJoinRun({ key, done: 0, total: joinable.length, result: null });
    const result = await planJoinSiteAsync(live, { locationId: loc, venueMenuId: joinMenuId || null, raw, siteName: siteLabel, orgId, idGen: newUuid }, {
      onProgress: (done, total) => setJoinRun((j) => (j && j.key === key ? { ...j, done, total } : j)),
      shouldStop: () => stopRef.current,
    });
    if (result) setJoinRun((j) => (j && j.key === key ? { ...j, result } : j));
  };

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

  const goJoin = async () => {
    if (!join?.ok) return;
    setBusy(true);
    const d = await api.createDraft(menu.id, `Add ${site?.name || 'a site'}`.slice(0, 80), 'add_site');
    if (!d.ok) { setBusy(false); setNote({ tone: 'bad', text: d.words }); return; }
    const r = await api.stageMany(d.data.id, join.changes, []);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: `The draft was made but ${r.failed.length || r.conflicts} change${(r.failed.length || r.conflicts) === 1 ? '' : 's'} did not go in: ${r.failed[0]?.words || 'try again'}.` }); }
    else setNote({ tone: 'good', text: `${site?.name || 'The site'} is in a draft, joining with the ${join.linked.length} product${join.linked.length === 1 ? '' : 's'} it already sells. Publishing changes nothing there; after that, one price change reaches it too.` });
    onStaged(d.data.id);
  };

  return (
    <Modal title="Add a site" sub="A new site gets the whole group menu in minutes. Nothing reaches it until you publish." width={640} onClose={onClose}
      footer={(
        <>
          <div style={{ flex: 1, ...ui.sub }}>{joining ? (join?.ok ? `${join.linked.length} product${join.linked.length === 1 ? '' : 's'} join as they are.` : working ? `Checking ${joinRun.done} of ${joinRun.total || '…'} products…` : '') : plan?.count ? `${plan.words}.` : ''}</div>
          <Btn onClick={onClose}>Cancel</Btn>
          {joining
            ? (join?.ok
              ? <Btn kind="primary" disabled={busy} onClick={goJoin} data-testid="msm-join-site">Join with what it sells now</Btn>
              : <Btn kind="primary" disabled={busy || working || !joinMenuId} onClick={workOutJoin} data-testid="msm-join-check">{working ? 'Checking…' : 'Check what joining changes'}</Btn>)
            : <Btn kind="primary" disabled={busy || !plan?.count || raw === null || raw === 'error'} onClick={go}>Put it in a new draft</Btn>}
        </>
      )}>
      {words && <Notice tone="bad">{words}</Notice>}
      {joining && (
        <div style={{ marginBottom: 12, display: 'grid', gap: 8 }}>
          <Notice tone="info">{site?.name || 'This site'} already sells {Math.max(owned.length, joinable.length)} of the group menu's products as its own copies (like {(joinable.length ? joinable.map((o) => o.name) : owned.map((i) => i.menu_name || i.name)).slice(0, 2).join(' and ')}). It joins with them as they are, so nothing it sells today changes. Check what joining changes first: it takes a few seconds.</Notice>
          {join && (join.ok
            ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{join.words.map((w) => <li key={w}>{w}</li>)}</ul>
            : <Notice tone="bad">{join.problems[0]}</Notice>)}
        </div>
      )}
      {company === null && <div style={ui.sub}>Reading the company's sites…</div>}
      {company && !company.length && <Notice>Every site of the company is already in the group menu.</Notice>}
      {company && company.length > 0 && (
        <>
          <Field label="Site">
            <select aria-label="Site" style={ui.input} value={loc} onChange={(e) => setLoc(e.target.value)}>
              {company.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Its menu" hint={menus.length ? 'A new menu is best for a new site. Adding to a menu it has puts the group\'s products in beside its own.' : 'This site has no menu yet: one is made when you publish.'}>
            {raw === null && <div style={ui.sub}>Reading the site…</div>}
            {raw === 'error' && <Notice tone="bad">Could not read this site.</Notice>}
            {raw && raw !== 'error' && (
              <select aria-label="Its menu" style={ui.input} value={joining ? joinMenuId : venueMenuId} onChange={(e) => setVenueMenuId(e.target.value)}>
                {!joining && <option value="">New menu called "{menu.name}" (recommended for a new site)</option>}
                {menus.map((m) => <option key={m.id} value={m.id}>{joining ? `Its menu "${m.name}" (${m.products} product${m.products === 1 ? '' : 's'} in it)` : `Add to ${site?.name || 'its'}'s existing menu "${m.name}": the group products go in beside its own`}</option>)}
              </select>
            )}
          </Field>
          {!joining && <Field label="Prices">
            <Segmented value={prices} onChange={setPrices} options={[{ value: 'default', label: 'The group prices' }, { value: 'copy', label: 'Copy from a site' }]} />
            {prices === 'copy' && (
              <select aria-label="Copy prices from" style={{ ...ui.input, marginTop: 8 }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name} (what it sells, at its prices)</option>)}
              </select>
            )}
          </Field>}
          {!joining && <div style={{ ...ui.sub, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)' }}>
            Publishing makes the site's menu, its categories, the modifier groups and every product, with VAT matched by name and rate.
            Set up its printers and kitchen screens in its own Back Office before it opens. You can schedule it for opening morning.
          </div>}
        </>
      )}
    </Modal>
  );
}
