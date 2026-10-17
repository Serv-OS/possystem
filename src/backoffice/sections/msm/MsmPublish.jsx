// src/backoffice/sections/msm/MsmPublish.jsx
//
// MULTI SITE MENU (v5.11.75): the Publish tab. Peter, 17 Oct 2026: "not just schedule price
// increase but schedule menu push so we can add items then say these items need to be on the POS
// by X date and time".
//
// For the draft being worked on:
//   1. The health check first: blocking problems (red) stop the publish, in words; warnings
//      (amber) let it through.
//   2. Exactly what changes at each site: a tab per site with its counts and every line, worked
//      out by the same planner the server runs (msmDiff.previewSet over each site's rows, read
//      fresh).
//   3. When: now, or a date and time read on each site's own clock, starting a few minutes early so
//      it is on every till by then. Overlaps with other scheduled sets are spelled out.
//   4. The button says what it does: "Publish to 6 sites now" or "Schedule for Mon 1 Dec 06:00
//      (starts 05:55)". After Publish now, each site's progress shows here until it is done.
// Nothing here writes a venue row: msm_publish_now / msm_schedule_set freeze the draft and the
// server does the rest (msmData.js).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyChanges, previewSet, sitesReached } from '../../../../supabase/functions/_shared/msmDiff.js';
import { startsWords, scheduleButtonWords, isPast, dueAt, overlaps, DEFAULT_LEAD_MINUTES } from '../../../../supabase/functions/_shared/msmSchedule.js';
import { defaultRunLocal, minRunLocal, publishNowWords, previewHeadline, versionSummary, siteRowWords } from '../../../lib/msm/msmPublishView';
import { Btn, Pill, Segmented, Notice, WindowedList, Field } from './msmUi';
import { ui } from './msmStyle';
import { useMsmHistory } from './useMsmHistory';

const LEADS = [
  { value: 0, label: 'Exactly at that time' },
  { value: 5, label: '5 minutes before (recommended)' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: 'An hour before' },
];

export default function MsmPublish({ api, menu, live, sites, sets, working, rows, canEdit, setWorkingId, setNote, setTab, refreshSets, reload }) {
  const [tracking, setTracking] = useState(null);          // { versionId, title, runWords }
  const history = useMsmHistory(api, menu?.id, { every: tracking ? 3000 : 20000, onSettled: () => { reload(); refreshSets(); } });
  const isDraft = working?.status === 'draft';

  // ── What the draft reaches, and each of those sites read fresh ───────────
  const after = useMemo(() => (live ? applyChanges(live, rows).central : null), [live, rows]);
  const reach = useMemo(() => (after && rows.length ? sitesReached(after, rows) : []), [after, rows]);
  const reachKey = reach.join('|');
  const [venues, setVenues] = useState({ key: '', map: null, failed: [] });
  const [rereading, setRereading] = useState(false);
  useEffect(() => {
    let on = true;
    if (!isDraft || !reachKey || venues.key === reachKey) return undefined;
    api.venues(reachKey.split('|')).then((r) => { if (on) setVenues({ key: reachKey, map: r.venues, failed: r.failed }); });
    return () => { on = false; };
  }, [api, isDraft, reachKey, venues.key]);
  const readVenues = async () => {
    if (!reachKey) return;
    setRereading(true);
    const r = await api.venues(reachKey.split('|'));
    setVenues({ key: reachKey, map: r.venues, failed: r.failed });
    setRereading(false);
  };
  const reading = rereading || (isDraft && !!reachKey && venues.key !== reachKey);

  const siteNames = useMemo(() => {
    const m = Object.fromEntries(sites.map((s) => [s.id, s.name]));
    for (const [loc, raw] of Object.entries(venues.map || {})) if (!m[loc] && raw?.location?.name) m[loc] = raw.location.name;
    return m;
  }, [sites, venues.map]);
  const tzOf = useCallback((loc) => sites.find((s) => s.id === loc)?.timezone || venues.map?.[loc]?.location?.timezone || 'Europe/London', [sites, venues.map]);

  const { preview, previewError } = useMemo(() => {
    if (!isDraft || !live || !rows.length || !venues.map || venues.key !== reachKey) return { preview: null, previewError: '' };
    try {
      return { preview: previewSet(live, rows, venues.map, { orgId: menu?.org_id || null, siteNames }), previewError: '' };
    } catch (e) {
      return { preview: null, previewError: `The preview could not be worked out: ${e.message}. Nothing was changed.` };
    }
  }, [isDraft, live, rows, venues.map, venues.key, reachKey, menu, siteNames]);
  const headline = useMemo(() => (preview ? previewHeadline(preview) : null), [preview]);

  // ── When ─────────────────────────────────────────────────────────────────
  const tz = tzOf(reach[0]);
  const mixedClocks = new Set(reach.map(tzOf)).size > 1;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const [mode, setMode] = useState('now');
  const [runLocal, setRunLocal] = useState(() => defaultRunLocal(Date.now(), tz));
  const [lead, setLead] = useState(DEFAULT_LEAD_MINUTES);
  const [idle, setIdle] = useState(true);
  const past = mode === 'schedule' && reach.some((loc) => isPast(runLocal, tzOf(loc), now));

  // Other scheduled sets, for the overlap words.
  const [otherChanges, setOtherChanges] = useState({});
  const scheduled = useMemo(() => sets.filter((s) => s.status === 'scheduled' && s.id !== working?.id), [sets, working]);
  useEffect(() => {
    let on = true;
    for (const s of scheduled) {
      if (otherChanges[s.id]) continue;
      api.changes(s.id).then((r) => { if (on && r.rows) setOtherChanges((m) => ({ ...m, [s.id]: r.rows })); });
    }
    return () => { on = false; };
  }, [api, scheduled, otherChanges]);
  const overlapWords = useMemo(() => {
    if (mode !== 'schedule' || !working || !rows.length) return [];
    const names = { ...siteNames };
    for (const p of after?.products || []) names[p.id] = p.menu_name || p.name;
    const firstDue = (setRow) => {
      const v = (history.rows || []).find((x) => x.id === setRow.version_id);
      const d = (v?.sites || []).map((x) => Date.parse(x.due_at)).filter(Number.isFinite);
      return d.length ? Math.min(...d) : null;
    };
    const list = scheduled.filter((s) => otherChanges[s.id]).map((s) => ({ id: s.id, title: s.title, due_at: firstDue(s), changes: otherChanges[s.id] }));
    const me = { id: '__this', title: working.title, due_at: dueAt(runLocal, tz, lead), changes: rows };
    return overlaps([...list, me], names, tz).overlaps.filter((o) => o.a === '__this' || o.b === '__this').map((o) => o.words);
  }, [mode, working, rows, siteNames, after, history.rows, scheduled, otherChanges, runLocal, tz, lead]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const reachSites = reach.map((loc) => ({ id: loc, name: siteNames[loc] || 'One site' }));
  const blocked = !preview || !preview.ok || reading;

  const publishNow = async () => {
    const tills = idle ? 'counter tills between sales' : 'counter tills when staff press Sync POS';
    if (!window.confirm(`${publishNowWords(reachSites)}?\n\n${headline?.words || ''}. Kiosks, kitchen screens and handhelds update straight away, ${tills}.`)) return;
    setBusy(true);
    const r = await api.publishNow(working.id, { applyWhenIdle: idle });
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setTracking({ versionId: r.data.version_id, title: working.title, runWords: r.data.runWords || '' });
    setWorkingId(null);
    await refreshSets();
    await history.refresh();
    reload();
  };

  const schedule = async () => {
    setBusy(true);
    const r = await api.schedule(working.id, runLocal, lead, idle);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setNote({ tone: 'good', text: `"${working.title}" is scheduled for ${scheduleButtonWords(runLocal, tz, lead).replace(/^Schedule for /, '')}. The tills update by themselves; nobody needs to be there.` });
    setWorkingId(null);
    await refreshSets();
    await history.refresh();
    setTab('timeline');
  };

  const stopScheduled = async (how) => {
    if (how === 'cancel' && !window.confirm(`Cancel "${working.title}"? It will not run, and nothing changes at any site. Its changes stay in the history.`)) return;
    setBusy(true);
    const r = how === 'cancel' ? await api.cancel(working.id) : await api.unschedule(working.id);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    await refreshSets();
    await history.refresh();
    if (how === 'cancel') setWorkingId(null);
    setNote({ tone: 'good', text: how === 'cancel' ? `"${working.title}" was cancelled. Nothing changed at any site.` : `"${working.title}" is a draft again, with every change kept. Change it, then schedule it again.` });
  };

  // ── Screens ──────────────────────────────────────────────────────────────
  const trackingVersion = tracking ? (history.rows || []).find((v) => v.id === tracking.versionId) : null;
  const progress = tracking && (
    <Progress version={trackingVersion} tracking={tracking} siteNames={siteNames} tzOf={tzOf} api={api} canEdit={canEdit} setNote={setNote}
      onRefresh={history.refresh} onClose={() => setTracking(null)} onTimeline={() => setTab('timeline')} />
  );

  if (!working) {
    const drafts = sets.filter((s) => s.status === 'draft');
    return (
      <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
        {progress}
        <div style={ui.card}>
          <div style={ui.h2}>Publish</div>
          <div style={{ ...ui.sub, marginBottom: drafts.length ? 12 : 0 }}>
            Changes collect in a draft. Pick one to see exactly what it changes at each site, then publish it now or schedule it, for example new products on the tills by 1 Dec 06:00.
          </div>
          {drafts.map((d) => (
            <div key={d.id} style={{ ...ui.row, padding: '9px 0', borderTop: '1px solid var(--bdr)' }}>
              <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>{d.title}</div>
              <Btn small kind="primary" onClick={() => setWorkingId(d.id)}>Open</Btn>
            </div>
          ))}
          {!drafts.length && <div style={{ marginTop: 12 }}><Btn small onClick={() => setTab('grid')}>Go to the menu</Btn></div>}
        </div>
      </div>
    );
  }

  if (!isDraft) {
    const v = (history.rows || []).find((x) => x.id === working.version_id);
    const sum = v ? versionSummary(v, siteNames) : null;
    const startedAlready = (v?.sites || []).some((s) => s.status !== 'scheduled') || v?.version_no != null;
    return (
      <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
        {progress}
        <div style={ui.card}>
          <div style={{ ...ui.row, marginBottom: 6 }}>
            <div style={{ ...ui.h2, flex: 1, margin: 0 }}>{working.title}</div>
            {sum && <Pill tone={sum.tone}>{sum.head}</Pill>}
          </div>
          {working.run_local && <div style={{ fontSize: 14, fontWeight: 700, margin: '6px 0' }}>{scheduleButtonWords(String(working.run_local).replace(' ', 'T'), tz, working.lead_minutes).replace(/^Schedule for /, 'On the tills by ')}</div>}
          {sum && <div style={ui.sub}>{sum.detail}</div>}
          <div style={{ ...ui.sub, marginTop: 8 }}>The tills update by themselves at that time. To change it, unschedule it: it becomes a draft again with every change kept.</div>
          {canEdit && working.status === 'scheduled' && !startedAlready && (
            <div style={{ ...ui.row, marginTop: 14 }}>
              <Btn kind="primary" disabled={busy} onClick={() => stopScheduled('unschedule')}>Unschedule to change it</Btn>
              <Btn kind="danger" disabled={busy} onClick={() => stopScheduled('cancel')}>Cancel it</Btn>
              <div style={{ flex: 1 }} />
              <Btn kind="link" onClick={() => setTab('timeline')}>Open the timeline</Btn>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
        {progress}
        <div style={ui.card}>
          <div style={ui.h2}>{working.title}</div>
          <div style={ui.sub}>This draft is empty. Change a price, turn a product on or off, or add products in the menu, then come back here to publish or schedule.</div>
          <div style={{ marginTop: 12 }}><Btn small onClick={() => setTab('grid')}>Go to the menu</Btn></div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ display: 'grid', gap: 14, minWidth: 0, flex: '1.6 1 460px' }}>
        {progress}
        <div style={ui.card}>
          <div style={{ ...ui.row, marginBottom: 4 }}>
            <div style={{ ...ui.h2, flex: 1, margin: 0 }}>What changes at each site</div>
            <Btn small kind="soft" disabled={reading} onClick={readVenues}>{reading ? 'Reading the sites…' : 'Read the sites again'}</Btn>
          </div>
          <div style={{ ...ui.sub, marginBottom: 12 }}>
            Worked out from each site's menu as it is right now, by the same rules the server publishes with. {headline ? `${headline.words}.` : ''}
          </div>
          {venues.failed.length > 0 && <div style={{ marginBottom: 10 }}><Notice tone="bad">Could not read {venues.failed.map((l) => siteNames[l] || 'one site').join(', ')}. Read the sites again before publishing.</Notice></div>}
          {previewError && <Notice tone="bad">{previewError}</Notice>}
          {!preview && !previewError && <div style={ui.sub}>Reading {reach.length} site{reach.length === 1 ? '' : 's'}…</div>}
          {preview && <SiteTabs preview={preview} />}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14, flex: '1 1 300px', minWidth: 0 }}>
        <HealthPanel preview={preview} siteNames={siteNames} />

        <div style={ui.card}>
          <div style={{ ...ui.h2, marginBottom: 10 }}>When</div>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'now', label: 'Now' }, { value: 'schedule', label: 'At a date and time' }]} />
          {mode === 'schedule' && (
            <div style={{ marginTop: 14 }}>
              <Field label="On the tills by" hint={mixedClocks ? 'Read on each site\'s own clock: 06:00 means 06:00 where each site is.' : 'On the site\'s own clock.'}>
                <input type="datetime-local" aria-label="On the tills by" style={ui.input} value={runLocal} min={minRunLocal(now, tz)} onChange={(e) => setRunLocal(e.target.value)} />
              </Field>
              <Field label="Start">
                <select aria-label="Start" style={ui.input} value={lead} onChange={(e) => setLead(Number(e.target.value))}>
                  {LEADS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </Field>
              {past ? <Notice tone="bad">That time has already passed{mixedClocks ? ' at one of the sites' : ''}. Pick a later one.</Notice>
                : <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>{startsWords(runLocal, tz, lead)}.</div>}
              {overlapWords.map((w) => <div key={w} style={{ marginTop: 8 }}><Notice>{w}</Notice></div>)}
            </div>
          )}
          <label style={{ ...ui.row, alignItems: 'flex-start', fontSize: 13, marginTop: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={idle} onChange={(e) => setIdle(e.target.checked)} style={{ marginTop: 2 }} />
            <span>Counter tills update by themselves between sales<span style={{ ...ui.sub, display: 'block' }}>Never in the middle of a sale. Off: staff see the usual Sync POS banner.</span></span>
          </label>
          <div style={{ ...ui.sub, marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)' }}>
            {mode === 'schedule'
              ? 'Nobody needs to be there: the server publishes at that time and the tills update by themselves. Kiosks, kitchen screens and handhelds take it straight away, online and QR on their next page load, menu boards within two minutes. You are emailed if a site fails.'
              : 'The tills update by themselves in the next few seconds. Kiosks, kitchen screens and handhelds take it straight away, online and QR on their next page load, menu boards within two minutes.'}
          </div>
          <div style={{ marginTop: 14 }}>
            {!canEdit && <div style={{ ...ui.sub, marginBottom: 8 }}>Only editors can publish.</div>}
            {preview && !preview.ok && <div style={{ ...ui.err, marginBottom: 8 }}>Fix the problems in red first; the button comes back by itself.</div>}
            {mode === 'now'
              ? <Btn kind="primary" style={{ width: '100%', padding: '11px 14px', fontSize: 14 }} disabled={!canEdit || busy || blocked} onClick={publishNow} data-testid="msm-publish-now">{busy ? 'Publishing…' : publishNowWords(reachSites)}</Btn>
              : <Btn kind="primary" style={{ width: '100%', padding: '11px 14px', fontSize: 14 }} disabled={!canEdit || busy || blocked || past} onClick={schedule} data-testid="msm-schedule">{busy ? 'Scheduling…' : scheduleButtonWords(runLocal, tz, lead)}</Btn>}
          </div>
        </div>
      </div>
    </div>
  );
}

// A tab per site: its counts, then every line of what changes there.
function SiteTabs({ preview }) {
  const [pick, setPick] = useState(null);
  const sites = preview.sites;
  const cur = sites.find((s) => s.location_id === pick) || sites[0];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {sites.map((s) => {
          const on = s === cur;
          const bad = s.missing || (s.health?.blocking || []).length > 0;
          return (
            <button key={s.location_id} type="button" onClick={() => setPick(s.location_id)} style={{
              textAlign: 'left', padding: '8px 11px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', minWidth: 120,
              border: `1px solid ${on ? 'var(--acc)' : bad ? 'var(--red-b)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg2)', color: 'var(--t1)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 750, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: bad ? 'var(--red)' : (s.plan?.lines?.length ? 'var(--acc)' : 'var(--t4)') }} />{s.name}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{s.missing ? 'Could not read' : s.plan?.lines?.length ? `${s.plan.lines.length} change${s.plan.lines.length === 1 ? '' : 's'}` : 'Nothing changes'}</div>
            </button>
          );
        })}
      </div>
      {cur && (
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>{cur.name}: {cur.words}</div>
          <WindowedList items={cur.lines || []} rowHeight={32} height={420}
            empty={<div style={ui.sub}>{cur.missing ? 'This site could not be read.' : 'Nothing changes at this site.'}</div>}
            renderRow={(l) => (
              <div style={{ ...ui.row, height: '100%', borderBottom: '1px solid var(--bdr)', fontSize: 13, padding: '0 4px' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: l.column === '(new)' ? 'var(--acc)' : l.column === 'archived' ? 'var(--t4)' : l.column?.startsWith('pricing.') ? 'var(--blu)' : 'var(--amber, #F5A623)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.words}</span>
              </div>
            )} />
        </div>
      )}
    </div>
  );
}

// Blocking problems in red (they stop the publish), warnings in amber (they let it through).
function HealthPanel({ preview, siteNames }) {
  const [showAll, setShowAll] = useState(false);
  if (!preview) return null;
  const block = [...(preview.central?.blocking || []).map((p) => ({ ...p, where: 'Every site' }))];
  const warn = [...(preview.central?.warnings || []).map((p) => ({ ...p, where: 'Every site' }))];
  for (const s of preview.sites) {
    if (s.missing) block.push({ code: 'unread', words: 'Could not read this site.', where: s.name });
    for (const p of s.health?.blocking || []) block.push({ ...p, where: s.name || siteNames[s.location_id] });
    for (const p of s.health?.warnings || []) warn.push({ ...p, where: s.name || siteNames[s.location_id] });
  }
  const shownWarn = showAll ? warn : warn.slice(0, 6);
  return (
    <div style={{ ...ui.card, borderColor: block.length ? 'var(--red-b)' : 'var(--bdr)' }}>
      <div style={{ ...ui.row, marginBottom: 8 }}>
        <div style={{ ...ui.h2, flex: 1, margin: 0 }}>Health check</div>
        {!block.length && !warn.length && <Pill tone="good">All clear</Pill>}
        {block.length > 0 && <Pill tone="bad">{block.length} to fix</Pill>}
        {warn.length > 0 && <Pill tone="warn">{warn.length} to look at</Pill>}
      </div>
      {!block.length && !warn.length && <div style={ui.sub}>Every product has a category, a price and a VAT rate at every site, and every new category prints somewhere.</div>}
      {block.map((p, i) => (
        <div key={`b${i}`} style={{ display: 'flex', gap: 8, padding: '6px 0', borderTop: i ? '1px solid var(--bdr)' : 'none', fontSize: 12.5 }}>
          <span style={{ color: 'var(--red)', fontWeight: 800 }}>●</span>
          <span><strong>{p.where}:</strong> {p.words}</span>
        </div>
      ))}
      {shownWarn.map((p, i) => (
        <div key={`w${i}`} style={{ display: 'flex', gap: 8, padding: '6px 0', borderTop: (i || block.length) ? '1px solid var(--bdr)' : 'none', fontSize: 12.5, color: 'var(--t2)' }}>
          <span style={{ color: 'var(--amber, #F5A623)', fontWeight: 800 }}>●</span>
          <span><strong>{p.where}:</strong> {p.words}</span>
        </div>
      ))}
      {warn.length > 6 && <Btn small kind="link" onClick={() => setShowAll((x) => !x)}>{showAll ? 'Show fewer' : `Show all ${warn.length}`}</Btn>}
    </div>
  );
}

// After Publish now: each site as it goes, until it is done.
function Progress({ version, tracking, siteNames, tzOf, api, canEdit, setNote, onRefresh, onClose, onTimeline }) {
  const [busy, setBusy] = useState('');
  const sum = version ? versionSummary(version, siteNames) : null;
  const open = !version || version.status === 'scheduled' || version.status === 'running';
  const retry = async (loc) => {
    setBusy(loc);
    const r = await api.retrySite(version.id, loc);
    setBusy('');
    if (!r.ok) setNote({ tone: 'bad', text: r.words });
    await onRefresh();
  };
  return (
    <div style={{ ...ui.card, borderColor: sum?.tone === 'bad' ? 'var(--red-b)' : 'var(--acc-b, var(--acc))' }}>
      <div style={{ ...ui.row, marginBottom: 6 }}>
        <div style={{ ...ui.h2, flex: 1, margin: 0 }}>{open ? 'Publishing' : 'Published'}: {tracking.title}</div>
        {sum && <Pill tone={sum.tone}>{sum.head}</Pill>}
      </div>
      <div style={{ ...ui.sub, marginBottom: 10 }}>
        {sum ? sum.detail : 'Starting…'}{tracking.runWords && open ? ` ${tracking.runWords}` : ''}
      </div>
      {(version?.sites || []).map((s) => (
        <div key={s.location_id} style={{ ...ui.row, padding: '6px 0', borderTop: '1px solid var(--bdr)', fontSize: 13 }}>
          <span style={{ flex: 1, fontWeight: 650 }}>{siteNames[s.location_id] || 'One site'}</span>
          <span style={{ color: s.status === 'failed' ? 'var(--red)' : 'var(--t3)', fontSize: 12.5, maxWidth: '60%', textAlign: 'right' }}>{siteRowWords(s, tzOf(s.location_id))}</span>
          {canEdit && s.status === 'failed' && <Btn small kind="soft" disabled={busy === s.location_id} onClick={() => retry(s.location_id)}>Retry {siteNames[s.location_id] || ''}</Btn>}
        </div>
      ))}
      <div style={{ ...ui.row, marginTop: 10 }}>
        <Btn small kind="link" onClick={onTimeline}>Open the timeline</Btn>
        <div style={{ flex: 1 }} />
        {!open && <Btn small onClick={onClose}>Done</Btn>}
      </div>
    </div>
  );
}
