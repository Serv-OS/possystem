// src/backoffice/sections/msm/MsmImport.jsx
//
// MULTI SITE MENU (v5.11.75): the first import. Reads the menus the sites have today, matches the
// products up, lets the person settle what the matching could not decide, proves that publishing
// straight after would change nothing at any site, and only then makes the group menu.
//
// WRITES NOTHING AT ANY SITE. msm_import_commit writes the group menu's own tables, in one
// transaction. Matching, choices and the zero writes check are pure and tested:
// supabase/functions/_shared/msmImport.js and src/lib/msm/msmImportReview.js.
//
//   1. Sites: every site of the company, ticked, with the menu to read at each.
//   2. Review: matched by family (nothing to do), matched by name only (tick to link), different
//      names (pick the group's), only at one site (site only extra or leave out, in bulk per site),
//      clashes (listed; each stays the site's own).
//   3. Check: "Publishing now would change 0 things at 0 sites", then Create.

import { useEffect, useMemo, useState } from 'react';
import { proposeImport, buildCentral, importPayload, reviewWords } from '../../../../supabase/functions/_shared/msmImport.js';
import {
  initialChoices, setNameTick, tickAllNames, setOnlyOne, setOnlyOneMany, filterOnlyOne, setGroupName, setLeaveOut,
  toDecisions, reviewCounts, importSummaryWords, venueMenuChoices,
} from '../../../lib/msm/msmImportReview';
import { Btn, Pill, Segmented, Field, Notice } from './msmUi';
import { ui, money } from './msmStyle';

export default function MsmImport({ api, client, orgId, orgName, readSites, onCancel, onDone }) {
  const [step, setStep] = useState('sites');      // sites | review | check
  const [company, setCompany] = useState(null);   // [{ id, name }]
  const [ticked, setTicked] = useState([]);
  const [name, setName] = useState(orgName ? `${orgName} menu` : 'Group menu');
  const [description, setDescription] = useState('');
  const [raws, setRaws] = useState({});           // loc -> raw venue
  const [failed, setFailed] = useState([]);
  const [menuAt, setMenuAt] = useState({});       // loc -> venue menu id
  const [reading, setReading] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [choices, setChoices] = useState(null);
  const [bucket, setBucket] = useState('onlyOne');
  const [built, setBuilt] = useState(null);
  const [working, setWorking] = useState('');
  const [words, setWords] = useState('');

  useEffect(() => {
    let on = true;
    readSites(client, { orgId }).then((r) => {
      if (!on) return;
      if (!r.rows) { setWords('Could not read your sites. Try again.'); setCompany([]); return; }
      setCompany(r.rows.map((x) => ({ id: x.id, name: x.name || 'Site' })));
      setTicked(r.rows.map((x) => x.id));
    });
    return () => { on = false; };
  }, [client, orgId, readSites]);

  const siteName = useMemo(() => new Map((company || []).map((s) => [s.id, s.name])), [company]);
  const read = async () => {
    setReading(true); setWords('');
    const r = await api.venues(ticked);
    setReading(false);
    setRaws(r.venues);
    setFailed(r.failed);
    const pick = {};
    for (const loc of ticked) {
      const choicesAt = venueMenuChoices(r.venues[loc]);
      if (choicesAt.length) pick[loc] = choicesAt[0].id;
    }
    setMenuAt(pick);
  };
  const ready = ticked.filter((l) => raws[l] && menuAt[l]);
  const importSites = () => ready.map((l) => ({ location_id: l, name: siteName.get(l), venue_menu_id: menuAt[l], raw: raws[l] }));

  const match = () => {
    setWorking('Matching the products…');
    setTimeout(() => {
      try {
        const p = proposeImport(importSites());
        setProposal(p);
        setChoices(initialChoices(p));
        setStep('review');
        setBucket(p.review.name.length ? 'name' : p.review.onlyOne.length ? 'onlyOne' : 'family');
      } catch (e) { setWords(`The matching stopped: ${e.message}`); }
      setWorking('');
    }, 30);
  };

  const check = () => {
    setWorking('Checking that publishing would change nothing…');
    setTimeout(() => {
      try {
        const b = buildCentral(proposal, importSites(), toDecisions(proposal, choices, { menuName: name, menuDescription: description }));
        setBuilt(b);
        setStep('check');
      } catch (e) { setWords(`The check stopped: ${e.message}`); }
      setWorking('');
    }, 30);
  };

  const create = async () => {
    setWorking('Making the group menu…'); setWords('');
    const r = await api.importCommit(importPayload(built.central, { orgId, name, description }));
    setWorking('');
    if (!r.ok) { setWords(r.words); return; }
    onDone(r.data);
  };

  return (
    <div style={{ maxWidth: 1080 }}>
      <div style={{ ...ui.row, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: 'var(--t4)', textTransform: 'uppercase' }}>Set up the multi site menu</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.5px', margin: '4px 0 2px' }}>{step === 'sites' ? '1. Your sites' : step === 'review' ? '2. Check the matches' : '3. Make the group menu'}</h1>
          <div style={ui.sub}>Nothing changes at any site while you do this, or when the group menu is made.</div>
        </div>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
      {words && <div style={{ marginBottom: 12 }}><Notice tone="bad">{words}</Notice></div>}
      {working && <div style={{ marginBottom: 12 }}><Notice tone="good">{working}</Notice></div>}

      {step === 'sites' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(360px, 1.6fr)', gap: 16, alignItems: 'start' }}>
          <div style={ui.card}>
            <Field label="Name of the group menu"><input style={ui.input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Description (optional)"><textarea style={{ ...ui.input, minHeight: 60 }} value={description} maxLength={600} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          <div style={ui.card}>
            <div style={ui.h2}>Sites</div>
            <div style={{ ...ui.sub, marginBottom: 10 }}>Every site you can open in this company. Untick any to leave out; they can join later.</div>
            {company === null && <div style={ui.sub}>Reading your sites…</div>}
            {(company || []).map((s) => {
              const raw = raws[s.id];
              const menus = raw ? venueMenuChoices(raw) : [];
              return (
                <div key={s.id} style={{ ...ui.row, padding: '8px 0', borderTop: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
                  <label style={{ ...ui.row, flex: 1, minWidth: 180, fontSize: 13.5, fontWeight: 650, cursor: 'pointer' }}>
                    <input type="checkbox" checked={ticked.includes(s.id)} onChange={() => setTicked((l) => (l.includes(s.id) ? l.filter((x) => x !== s.id) : [...l, s.id]))} />
                    {s.name}
                  </label>
                  {failed.includes(s.id) && <Pill tone="bad">Could not read its menu</Pill>}
                  {raw && !menus.length && <Pill tone="warn">No menu yet: add it later as a new site</Pill>}
                  {raw && menus.length > 0 && (
                    <select aria-label={`Menu at ${s.name}`} style={{ ...ui.input, width: 260 }} value={menuAt[s.id] || ''} onChange={(e) => setMenuAt((m) => ({ ...m, [s.id]: e.target.value }))}>
                      {menus.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.products} products){m.isDefault ? ', default' : ''}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
            <div style={{ ...ui.row, marginTop: 14 }}>
              <Btn kind={Object.keys(raws).length ? 'soft' : 'primary'} disabled={reading || !ticked.length} onClick={read}>{reading ? 'Reading…' : Object.keys(raws).length ? 'Read again' : 'Read their menus'}</Btn>
              {Object.keys(raws).length > 0 && <Btn kind="primary" disabled={ready.length < 1 || !!working || !name.trim()} onClick={match}>Match the products at {ready.length} site{ready.length === 1 ? '' : 's'}</Btn>}
            </div>
          </div>
        </div>
      )}

      {step === 'review' && proposal && choices && (
        <Review proposal={proposal} choices={choices} setChoices={setChoices} bucket={bucket} setBucket={setBucket} siteName={siteName} siteIds={ready}
          onBack={() => setStep('sites')} onNext={check} busy={!!working} />
      )}

      {step === 'check' && built && (
        <div style={ui.card}>
          {built.check.ok ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Ready</div>
              <div style={{ fontSize: 14, marginBottom: 16 }} data-testid="msm-import-summary">{importSummaryWords(built.central, built.check)}</div>
              <div style={{ ...ui.sub, marginBottom: 16 }}>
                Where a site's price differs from the group's, it is kept as that site's own price. Where a site has its own name, photo, category or VAT for a product, it keeps it, and publishing never changes it there until you say so.
              </div>
              <div style={{ ...ui.row }}>
                <Btn onClick={() => setStep('review')}>Back to the matches</Btn>
                <Btn kind="primary" disabled={!!working} onClick={create}>Make the group menu</Btn>
              </div>
            </>
          ) : (
            <>
              <Notice tone="bad">{importSummaryWords(built.central, built.check)}</Notice>
              <div style={{ margin: '12px 0', fontSize: 13 }}>
                {built.check.problems.slice(0, 40).map((p, i) => <div key={i} style={{ padding: '3px 0' }}>{siteName.get(p.location_id) || 'A site'}: {p.words}</div>)}
              </div>
              <div style={ui.sub}>Leave those products out in the review, or settle them in each site's Menu Manager first, then check again.</div>
              <div style={{ marginTop: 12 }}><Btn onClick={() => setStep('review')}>Back to the matches</Btn></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Review({ proposal, choices, setChoices, bucket, setBucket, siteName, siteIds, onBack, onNext, busy }) {
  const r = proposal.review;
  const counts = reviewCounts(proposal, choices, siteIds);
  const pName = useMemo(() => new Map(proposal.products.map((p) => [p.id, p.menu_name || p.name])), [proposal]);
  const pPrice = useMemo(() => new Map(proposal.products.map((p) => [p.id, p.default_price])), [proposal]);
  const [site, setSite] = useState('');
  const [archived, setArchived] = useState('all');
  const [search, setSearch] = useState('');
  const filter = { location_id: site || null, archived: archived === 'all' ? null : archived === 'archived', search };
  const shownOnly = filterOnlyOne(proposal, filter);
  const leave = new Set(choices.leaveOut);

  const tabs = [
    { value: 'family', label: `Matched (${counts.family})` },
    { value: 'name', label: `Name only (${counts.nameTicked}/${counts.name})` },
    { value: 'names', label: `Different names (${counts.names})` },
    { value: 'onlyOne', label: `One site only (${counts.onlyOne.extra + counts.onlyOne.leave})` },
    ...(counts.clashes ? [{ value: 'clashes', label: `Clashes (${counts.clashes})` }] : []),
  ];

  return (
    <div>
      <div style={{ ...ui.card, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{reviewWords(r)}</div>
        <div style={{ ...ui.sub, marginTop: 4 }}>Matched products are linked across sites. Settle the rest below, then check.</div>
      </div>
      <div style={{ marginBottom: 12 }}><Segmented value={bucket} onChange={setBucket} options={tabs} /></div>
      <div style={{ ...ui.card, padding: 0, overflow: 'hidden' }}>
        <div style={{ maxHeight: 'calc(100vh - 420px)', minHeight: 260, overflowY: 'auto' }}>
          {bucket === 'family' && r.family.map((f) => (
            <Line key={f.productId} title={pName.get(f.productId)} sub={`${f.sites} sites · group price ${money(pPrice.get(f.productId))}`} off={leave.has(f.productId)}>
              <Btn small kind={leave.has(f.productId) ? 'soft' : 'link'} onClick={() => setChoices(setLeaveOut(choices, f.productId, !leave.has(f.productId)))}>{leave.has(f.productId) ? 'Left out: put back' : 'Leave out'}</Btn>
            </Line>
          ))}
          {bucket === 'name' && (
            <>
              <div style={{ ...ui.row, padding: '10px 14px', borderBottom: '1px solid var(--bdr)' }}>
                <span style={{ ...ui.sub, flex: 1 }}>Same name at different sites, but not shared from one product. Tick the ones that are the same product. Unticked ones stay each site's own.</span>
                <Btn small kind="soft" onClick={() => setChoices(tickAllNames(choices, proposal, true))}>Tick all</Btn>
                <Btn small kind="soft" onClick={() => setChoices(tickAllNames(choices, proposal, false))}>Untick all</Btn>
              </div>
              {r.name.map((n) => {
                const on = choices.tickName.includes(n.productId);
                return (
                  <Line key={n.productId} title={<label style={{ ...ui.row, cursor: 'pointer' }}><input type="checkbox" checked={on} onChange={() => setChoices(setNameTick(choices, n.productId, !on))} />{pName.get(n.productId)}</label>}
                    sub={n.names.map((x) => `${siteName.get(x.location_id) || 'Site'}: ${x.name}`).join(' · ')} />
                );
              })}
              {!r.name.length && <Empty>Nothing to tick.</Empty>}
            </>
          )}
          {bucket === 'names' && (
            <>
              {r.differentNames.map((d) => {
                const opts = [...new Set(d.names.map((x) => x.name))];
                const cur = choices.names[d.productId] ?? pName.get(d.productId);
                return (
                  <Line key={d.productId} title={pName.get(d.productId)} sub={d.names.map((x) => `${siteName.get(x.location_id) || 'Site'}: ${x.name}`).join(' · ')}>
                    <select aria-label="Group name" style={{ ...ui.input, width: 220 }} value={opts.includes(cur) ? cur : '__own'} onChange={(e) => { if (e.target.value !== '__own') setChoices(setGroupName(choices, d.productId, e.target.value)); }}>
                      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                      {!opts.includes(cur) && <option value="__own">{cur}</option>}
                    </select>
                  </Line>
                );
              })}
              {!r.differentNames.length && <Empty>Every matched product has one name.</Empty>}
              {r.differentNames.length > 0 && <div style={{ ...ui.sub, padding: '10px 14px' }}>Each site keeps its own name until you publish a change to it.</div>}
            </>
          )}
          {bucket === 'onlyOne' && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--bdr)', position: 'sticky', top: 0, background: 'var(--bg1)', zIndex: 1 }}>
                <select aria-label="Site" style={{ ...ui.input, width: 180 }} value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="">Every site</option>
                  {siteIds.map((l) => <option key={l} value={l}>{siteName.get(l)} ({counts.perSite[l]?.onlyOne || 0})</option>)}
                </select>
                <select aria-label="Archived" style={{ ...ui.input, width: 170 }} value={archived} onChange={(e) => setArchived(e.target.value)}>
                  <option value="all">On and off</option>
                  <option value="active">On sale there</option>
                  <option value="archived">Off at that site</option>
                </select>
                <input aria-label="Search" style={{ ...ui.input, width: 160 }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div style={{ flex: 1 }} />
                <Btn small kind="soft" disabled={!shownOnly.length} onClick={() => setChoices(setOnlyOneMany(choices, proposal, filter, 'extra').choices)}>Make all {shownOnly.length} site only extras</Btn>
                <Btn small kind="soft" disabled={!shownOnly.length} onClick={() => setChoices(setOnlyOneMany(choices, proposal, filter, 'leave').choices)}>Leave all {shownOnly.length} out</Btn>
              </div>
              {shownOnly.map((o) => (
                <Line key={o.productId} title={o.name} sub={`${siteName.get(o.location_id) || 'Site'}${o.archived ? ' · off at that site' : ''} · ${money(pPrice.get(o.productId))}`} off={(choices.onlyOne[o.productId] || o.defaultChoice) === 'leave'}>
                  <Segmented small value={choices.onlyOne[o.productId] || o.defaultChoice} onChange={(v) => setChoices(setOnlyOne(choices, o.productId, v))}
                    options={[{ value: 'extra', label: 'Site only extra' }, { value: 'leave', label: 'Leave out' }]} />
                </Line>
              ))}
              {!shownOnly.length && <Empty>Nothing here.</Empty>}
              <div style={{ ...ui.sub, padding: '10px 14px' }}>A site only extra is managed here and sold at that one site. Left out, it stays that site's own product, exactly as it is today.</div>
            </>
          )}
          {bucket === 'clashes' && r.clashes.map((c, i) => (
            <Line key={i} title={c.name} sub={`${siteName.get(c.location_id) || 'Site'} has ${c.ids.length} products with this name. The first is matched; the others stay that site's own.`} />
          ))}
        </div>
      </div>
      <div style={{ ...ui.row, marginTop: 14 }}>
        <Btn onClick={onBack}>Back</Btn>
        <div style={{ flex: 1, ...ui.sub }}>{counts.onlyOne.extra} site only extras, {counts.onlyOne.leave + choices.leaveOut.length} left out.</div>
        <Btn kind="primary" disabled={busy} onClick={onNext}>Check and continue</Btn>
      </div>
    </div>
  );
}

function Line({ title, sub, off, children }) {
  return (
    <div style={{ ...ui.row, padding: '9px 14px', borderBottom: '1px solid var(--bdr)', opacity: off ? 0.55 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>{title}</div>
        {sub && <div style={{ ...ui.sub, fontSize: 12 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}
const Empty = ({ children }) => <div style={{ padding: 20, ...ui.sub }}>{children}</div>;
