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
//   1. Sites: every site of the company, ticked, with the menu to read at each (products counted,
//      never their sizes).
//   2. Review: already shared (linked for you; Leave out takes the sizes too), set up separately
//      (Same product, Keep separate or Leave out), different names (pick the group's), one site
//      only (bring in, on at that site only, or leave out), clashes (each line says what happens).
//   3. Check: "Publishing now would change 0 things at 0 sites", then Create (never with every
//      product left out: there is nothing to make).
//
// ROUND 2, builder 3 (design 2 item 12): the menus are read as soon as the sites are known; step 2
// is a checklist whose lists carry "Needs you" until looked at, and going on past a list nobody
// opened asks first; step 3 says "Safe to make".
//
// REVIEW FIX (20 Oct 2026, v5.11.83): every line is a PRODUCT, with its category and its sizes
// under it; a size is never a line of its own. Switched off (deleted) rows are never listed: they
// only ride along, off, inside a shared product, and one line counts the rest. Clashes are only
// rows on sale, each copy named with its price and category, and one sentence says what happens
// (and follows the choices: a copy that is left out never says it goes in the group menu).
// Name matches are Same product, Keep separate or Leave out, each in words, with each site's own
// price and sizes. All words come from msmImportReview.js (pure, tested).

import { useEffect, useMemo, useState } from 'react';
import { proposeImport, buildCentral, importPayload, reviewWords } from '../../../../supabase/functions/_shared/msmImport.js';
import {
  initialChoices, tickAllNames, setNameChoice, nameChoiceOf, setOnlyOne, setOnlyOneMany, filterOnlyOne, setGroupName, setLeaveOut,
  toDecisions, reviewCounts, needsOf, footerWords, importSummaryWords, canMakeGroupMenu, nothingToMake, venueMenuChoices,
  reviewView, sharedLine, nameLine, namesLine, onlyOneLine, clashLine, clashLeftOut, rowsComingIn, switchedOffWords, REVIEW_WORDS,
} from '../../../lib/msm/msmImportReview';
import { Btn, Pill, Segmented, Field, Notice } from './msmUi';
import { ui, money } from './msmStyle';
import { useConfirm } from './useConfirm';

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

  // The company's sites, then straight away their menus (nobody has to press Read first).
  useEffect(() => {
    let on = true;
    readSites(client, { orgId }).then(async (r) => {
      if (!on) return;
      if (!r.rows) { setWords('Could not read your sites. Try again.'); setCompany([]); return; }
      setCompany(r.rows.map((x) => ({ id: x.id, name: x.name || 'Site' })));
      const ids = r.rows.map((x) => x.id);
      setTicked(ids);
      if (!ids.length) return;
      setReading(true);
      const v = await api.venues(ids);
      if (!on) return;
      setReading(false);
      setRaws(v.venues);
      setFailed(v.failed);
      const pick = {};
      for (const loc of ids) { const at = venueMenuChoices(v.venues[loc]); if (at.length) pick[loc] = at[0].id; }
      setMenuAt(pick);
    });
    return () => { on = false; };
  }, [api, client, orgId, readSites]);

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
  // One array per change of sites or menus (the review's lines are memoised on it).
  const ready = useMemo(() => ticked.filter((l) => raws[l] && menuAt[l]), [ticked, raws, menuAt]);
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
    if (!built || !canMakeGroupMenu(built.central, built.check)) return;
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
            <div style={{ ...ui.sub, marginBottom: 10 }}>Every site you can open in this company. Tick every site that already has its own menu now: Add a site later is only for a site that does not sell these products yet.</div>
            {company === null && <div style={ui.sub}>Reading your sites…</div>}
            {reading && <div style={{ ...ui.sub, marginBottom: 6 }}>Reading each site's menu…</div>}
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
          {nothingToMake(built.central) ? (
            <>
              <Notice tone="warn">{importSummaryWords(built.central, built.check)}</Notice>
              <div style={{ marginTop: 12 }}><Btn onClick={() => setStep('review')}>Back to the matches</Btn></div>
            </>
          ) : built.check.ok ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Safe to make: nothing changes at any site today.</div>
              <div style={{ fontSize: 14, marginBottom: 16 }} data-testid="msm-import-summary">{importSummaryWords(built.central, built.check)}</div>
              <div style={{ ...ui.sub, marginBottom: 16 }}>
                Where a site's price differs from the group's, it is kept as that site's own price. Where a site has its own name, photo, category or VAT for a product, it keeps it, and publishing never changes it there until you say so.
              </div>
              <div style={{ ...ui.row }}>
                <Btn onClick={() => setStep('review')}>Back to the matches</Btn>
                <Btn kind="primary" disabled={!!working || !canMakeGroupMenu(built.central, built.check)} onClick={create}>Make the group menu</Btn>
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
  const W = REVIEW_WORDS;
  const counts = reviewCounts(proposal, choices, siteIds);
  const nameOf = useMemo(() => (loc) => siteName.get(loc) || 'Site', [siteName]);
  const [site, setSite] = useState('');
  const [search, setSearch] = useState('');
  const [visited, setVisited] = useState(() => new Set([bucket]));
  const [confirm, confirmDialog] = useConfirm();
  const filter = useMemo(() => ({ location_id: site || null, search }), [site, search]);
  const { tickName, leaveName, leaveOut, onlyOne: oneChoices } = choices;
  const opts = useMemo(() => ({ siteName: nameOf, money, siteIds }), [nameOf, siteIds]);
  // The proposal as the name choices have it (a join that is not Same product is taken out).
  const view = useMemo(() => reviewView(proposal, { tickName, leaveName }), [proposal, tickName, leaveName]);

  // Each list's lines, worked out once per change that touches them.
  const sharedLines = useMemo(() => {
    const out = new Set(leaveOut);
    const joins = new Map(r.name.filter((n) => n.joined).map((n) => [n.productId, n]));
    const lines = r.family.map((f) => {
      const j = joins.get(f.productId);
      const joinApart = j && nameChoiceOf({ tickName, leaveName }, f.productId) === 'apart' ? j.byName.map(nameOf) : [];
      return { id: f.productId, off: out.has(f.productId), ...sharedLine(view, f.productId, { ...opts, leftOut: out.has(f.productId), joinApart }) };
    });
    return { own: lines.filter((l) => !l.optionsOnly), options: lines.filter((l) => l.optionsOnly) };
  }, [view, leaveOut, r, tickName, leaveName, opts, nameOf]);
  const nameLines = useMemo(() => {
    const out = new Set(leaveOut);
    return r.name.map((n) => ({ id: n.productId, choice: nameChoiceOf({ tickName, leaveName }, n.productId), ...nameLine(proposal, n, { ...opts, sharedLeftOut: n.joined && out.has(n.productId) }) }));
  }, [proposal, r, tickName, leaveName, leaveOut, opts]);
  const shownOnly = useMemo(() => filterOnlyOne(proposal, filter), [proposal, filter]);
  const oneLines = useMemo(() => shownOnly.map((o) => {
    const choice = oneChoices[o.productId] || o.defaultChoice;
    return { id: o.productId, choice, ...onlyOneLine(view, o, { ...opts, choice }) };
  }), [shownOnly, view, oneChoices, opts]);
  // Clashes follow the choices: a copy marked to come in that is left out says so.
  const comingIn = useMemo(() => (r.clashes.length ? rowsComingIn(proposal, { tickName, leaveName, leaveOut, onlyOne: oneChoices }) : null), [proposal, r, tickName, leaveName, leaveOut, oneChoices]);
  const clashLines = useMemo(() => r.clashes.map((c) => clashLine(c, { ...opts, leftOut: clashLeftOut(c, comingIn) })), [r, opts, comingIn]);

  // Lists that need a person's eye: "Needs you" until opened once. Clashes only ask for a look.
  const needs = needsOf(counts);
  const badge = (k) => (needs[k] && !visited.has(k) ? W.needsYou : '');
  const tabs = [
    { value: 'family', label: `${W.family.tab} (${counts.family})` },
    { value: 'name', label: `${W.name.tab} (${counts.name})${badge('name')}` },
    { value: 'names', label: `${W.names.tab} (${counts.names})${badge('names')}` },
    { value: 'onlyOne', label: `${W.onlyOne.tab} (${counts.onlyOne.extra + counts.onlyOne.leave})${badge('onlyOne')}` },
    ...(counts.clashes ? [{ value: 'clashes', label: `${W.clashes.tab} (${counts.clashes})${visited.has('clashes') ? '' : W.worthALook}` }] : []),
  ];
  const LIST_WORDS = { name: W.name.tab, names: W.names.tab, onlyOne: W.onlyOne.tab };
  const pickBucket = (b) => { setBucket(b); setVisited((v) => new Set([...v, b])); };
  const next = async () => {
    const missed = Object.keys(needs).filter((k) => needs[k] && !visited.has(k)).map((k) => LIST_WORDS[k]);
    if (missed.length && !(await confirm({ title: 'Go on without looking?', words: `You have not looked at ${missed.join(', ')} yet. The choices already made there are used.`, yes: 'Go on anyway', no: 'Look first' }))) return;
    onNext();
  };
  const offLine = switchedOffWords(r);
  const sharedRow = (l) => (
    <Line key={l.id} title={l.title} sub={l.sub} sizes={l.sizes} notes={l.notes} off={l.off}>
      <Btn small kind={l.off ? 'soft' : 'link'} onClick={() => setChoices(setLeaveOut(choices, l.id, !l.off))}>{l.off ? W.family.putBack : W.family.leaveOut}</Btn>
    </Line>
  );

  return (
    <div>
      {confirmDialog}
      <div style={{ ...ui.card, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{reviewWords(r)}</div>
        {offLine && <div style={{ ...ui.sub, marginTop: 4 }}>{offLine}</div>}
        <div style={{ ...ui.sub, marginTop: 4 }}>{W.intro}</div>
      </div>
      <div style={{ marginBottom: 12 }}><Segmented value={bucket} onChange={pickBucket} options={tabs} /></div>
      <div style={{ ...ui.card, padding: 0, overflow: 'hidden' }}>
        <div style={{ maxHeight: 'calc(100vh - 420px)', minHeight: 260, overflowY: 'auto' }}>
          {bucket === 'family' && (
            <>
              <Header>{W.family.header}</Header>
              {sharedLines.own.map(sharedRow)}
              {sharedLines.options.length > 0 && <div style={{ ...ui.sub, fontWeight: 700, padding: '10px 14px 4px', borderBottom: '1px solid var(--bdr)' }}>{W.family.optionsHeading}</div>}
              {sharedLines.options.map(sharedRow)}
              {!r.family.length && <Empty>{W.family.empty}</Empty>}
            </>
          )}
          {bucket === 'name' && (
            <>
              <div style={{ ...ui.row, padding: '10px 14px', borderBottom: '1px solid var(--bdr)' }}>
                <span style={{ ...ui.sub, flex: 1 }}>{W.name.header}</span>
                <Btn small kind="soft" onClick={() => setChoices(tickAllNames(choices, proposal, true))}>{W.name.allSame}</Btn>
                <Btn small kind="soft" onClick={() => setChoices(tickAllNames(choices, proposal, false))}>{W.name.allApart}</Btn>
              </div>
              {nameLines.map((l) => (
                <Line key={l.id} title={l.title} lead={l.lead} picks={[l.choices.same, l.choices.apart, l.choices.leave]} rows={l.rows} notes={l.notes} footer={l.footer} off={l.choice === 'leave'}>
                  <Segmented small value={l.choice} onChange={(v) => setChoices(setNameChoice(choices, l.id, v))}
                    options={[{ value: 'same', label: W.name.same }, { value: 'apart', label: W.name.apart }, { value: 'leave', label: W.name.leave }]} />
                </Line>
              ))}
              {!r.name.length && <Empty>{W.name.empty}</Empty>}
            </>
          )}
          {bucket === 'names' && (
            <>
              <Header>{W.names.header}</Header>
              {r.differentNames.map((d) => {
                const l = namesLine(proposal, d, choices.names[d.productId], opts);
                return (
                  <Line key={d.productId} title={(
                    <label style={{ ...ui.row, flexWrap: 'wrap' }}>
                      <span>{l.label}</span>
                      <select aria-label="Group menu name" style={{ ...ui.input, width: 240 }} value={l.value} onChange={(e) => setChoices(setGroupName(choices, d.productId, e.target.value))}>
                        {l.options.map((x) => <option key={x} value={x}>{x}</option>)}
                        {!l.options.includes(l.value) && <option value={l.value}>{l.value}</option>}
                      </select>
                    </label>
                  )} sub={l.sub} />
                );
              })}
              {!r.differentNames.length && <Empty>{W.names.empty}</Empty>}
            </>
          )}
          {bucket === 'onlyOne' && (
            <>
              <Header>{W.onlyOne.header}</Header>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--bdr)', position: 'sticky', top: 0, background: 'var(--bg1)', zIndex: 1 }}>
                <select aria-label="Site" style={{ ...ui.input, width: 200 }} value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="">Every site</option>
                  {siteIds.map((l) => <option key={l} value={l}>{nameOf(l)} ({counts.perSite[l]?.onlyOne || 0})</option>)}
                </select>
                <input aria-label="Search" style={{ ...ui.input, width: 160 }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div style={{ flex: 1 }} />
                <Btn small kind="soft" disabled={!shownOnly.length} onClick={() => setChoices(setOnlyOneMany(choices, proposal, filter, 'extra').choices)}>Bring in all {shownOnly.length}</Btn>
                <Btn small kind="soft" disabled={!shownOnly.length} onClick={() => setChoices(setOnlyOneMany(choices, proposal, filter, 'leave').choices)}>Leave all {shownOnly.length} out</Btn>
              </div>
              {oneLines.map((l) => (
                <Line key={l.id} title={l.title} sub={l.sub} sizes={l.sizes} notes={l.notes} off={l.choice === 'leave'}>
                  <Segmented small value={l.choice} onChange={(v) => setChoices(setOnlyOne(choices, l.id, v))}
                    options={[{ value: 'extra', label: W.onlyOne.bringIn }, { value: 'leave', label: W.onlyOne.leaveOut }]} />
                </Line>
              ))}
              {!shownOnly.length && <Empty>{W.onlyOne.empty}</Empty>}
            </>
          )}
          {bucket === 'clashes' && (
            <>
              <Header>{W.clashes.header}</Header>
              {clashLines.map((l, i) => <Line key={i} title={l.title} lead={l.situation} rows={l.copies} footer={l.words} />)}
              {!clashLines.length && <Empty>{W.clashes.empty}</Empty>}
            </>
          )}
        </div>
      </div>
      <div style={{ ...ui.row, marginTop: 14 }}>
        <Btn onClick={onBack}>Back</Btn>
        <div style={{ flex: 1, ...ui.sub }}>{footerWords(counts, choices)}</div>
        <Btn kind="primary" disabled={busy} onClick={next}>Check and continue</Btn>
      </div>
    </div>
  );
}

// "Same product: ..." with the choice's name in bold.
function Pick({ words }) {
  const i = words.indexOf(': ');
  if (i < 0) return <div>{words}</div>;
  return <div><b>{words.slice(0, i)}:</b> {words.slice(i + 2)}</div>;
}

function Line({ title, sub, lead, picks, sizes, rows, notes, footer, off, children }) {
  const small = { ...ui.sub, fontSize: 12 };
  return (
    <div style={{ ...ui.row, alignItems: 'flex-start', padding: '9px 14px', borderBottom: '1px solid var(--bdr)', opacity: off ? 0.55 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>{title}</div>
        {sub && <div style={small}>{sub}</div>}
        {lead && <div style={{ ...small, marginTop: 2 }}>{lead}</div>}
        {picks && picks.length > 0 && <div style={{ ...small, marginTop: 4, display: 'grid', gap: 2 }}>{picks.map((w, i) => <Pick key={i} words={w} />)}</div>}
        {sizes && <div style={small}>{sizes}</div>}
        {rows && rows.length > 0 && <div style={{ ...small, marginTop: 4 }}>{rows.map((x, i) => <div key={i}>{x}</div>)}</div>}
        {notes && notes.length > 0 && <div style={{ ...small, marginTop: 4 }}>{notes.map((x, i) => <div key={i}>{x}</div>)}</div>}
        {footer && <div style={{ ...small, marginTop: 4 }}>{footer}</div>}
      </div>
      {children}
    </div>
  );
}
const Header = ({ children }) => <div style={{ ...ui.sub, padding: '10px 14px', borderBottom: '1px solid var(--bdr)' }}>{children}</div>;
const Empty = ({ children }) => <div style={{ padding: 20, ...ui.sub }}>{children}</div>;
