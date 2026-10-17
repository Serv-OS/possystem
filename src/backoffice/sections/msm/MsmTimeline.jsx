// src/backoffice/sections/msm/MsmTimeline.jsx
//
// MULTI SITE MENU (v5.11.75): the Timeline tab. Coming up: every scheduled set in the order it
// runs, with when it is on the tills, a countdown, each site's start time, the pre check an hour
// before ("Will fail") and the overlaps between sets; View, Unschedule (back to a draft with every
// change kept) and Cancel until it starts. Below: every publish as a version, newest first, with
// each site's result, what it wrote there in words, Retry for a site that failed, and Undo.
//
// Undo never rewinds history: it makes a NEW draft that puts the version's changes back
// (msmDiff.undoChanges: a new product is turned off, never deleted) and opens it in Publish, so the
// same preview and health check show before anything moves.

import { useEffect, useMemo, useState } from 'react';
import { undoChanges } from '../../../../supabase/functions/_shared/msmDiff.js';
import { overlaps, whenText, clockText } from '../../../../supabase/functions/_shared/msmSchedule.js';
import { timelineEntries, canStillChange, versionSummary, siteRowWords, countdownWords, auditLines } from '../../../lib/msm/msmPublishView';
import { changeWords } from '../../../lib/msm/msmWords';
import { withBefore } from '../../../lib/msm/msmEdit';
import { Btn, Pill, Notice, Modal, WindowedList } from './msmUi';
import { ui } from './msmStyle';
import { useMsmHistory } from './useMsmHistory';

const KIND = { publish: 'Published', scheduled: 'Scheduled', undo: 'Undo', import: 'Import', add_site: 'Site added' };

export default function MsmTimeline({ api, menu, live, sites, sets, canEdit, setWorkingId, setNote, setTab, refreshSets, reload }) {
  const history = useMsmHistory(api, menu?.id, { every: 15000, onSettled: () => { reload(); refreshSets(); } });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const siteNames = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);
  const tzOf = (loc) => sites.find((s) => s.id === loc)?.timezone || 'Europe/London';
  const names = useMemo(() => ({
    products: new Map((live?.products || []).map((p) => [p.id, p.menu_name || p.name])),
    categories: new Map((live?.categories || []).map((c) => [c.id, c.label])),
    sites: new Map(sites.map((s) => [s.id, s.name])),
  }), [live, sites]);

  // Coming up, and each set's changes for the overlap words.
  const entries = useMemo(() => timelineEntries(sets, history.rows || [], now), [sets, history.rows, now]);
  const [changesOf, setChangesOf] = useState({});
  useEffect(() => {
    let on = true;
    for (const e of entries) {
      if (changesOf[e.set.id]) continue;
      api.changes(e.set.id).then((r) => { if (on && r.rows) setChangesOf((m) => ({ ...m, [e.set.id]: r.rows })); });
    }
    return () => { on = false; };
  }, [api, entries, changesOf]);
  const overlapBy = useMemo(() => {
    const flat = { ...siteNames };
    for (const p of live?.products || []) flat[p.id] = p.menu_name || p.name;
    const o = overlaps(entries.filter((e) => changesOf[e.set.id]).map((e) => ({ id: e.set.id, title: e.set.title, due_at: e.firstDue, changes: changesOf[e.set.id] })), flat);
    const by = new Map();
    for (const x of o.overlaps) { for (const id of [x.a, x.b]) { if (!by.has(id)) by.set(id, []); by.get(id).push(x.words); } }
    return by;
  }, [entries, changesOf, siteNames, live]);

  const past = useMemo(() => (history.rows || []).filter((v) => v.status !== 'scheduled'), [history.rows]);

  const [busy, setBusy] = useState('');
  const stop = async (entry, how) => {
    if (how === 'cancel' && !window.confirm(`Cancel "${entry.set.title}"? It will not run, and nothing changes at any site.`)) return;
    setBusy(entry.set.id);
    const r = how === 'cancel' ? await api.cancel(entry.set.id) : await api.unschedule(entry.set.id);
    setBusy('');
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    await refreshSets();
    await history.refresh();
    if (how === 'unschedule') { setWorkingId(entry.set.id); setNote({ tone: 'good', text: `"${entry.set.title}" is a draft again, with every change kept. It is open in the menu now.` }); setTab('grid'); }
    else setNote({ tone: 'good', text: `"${entry.set.title}" was cancelled. Nothing changed at any site.` });
  };
  const view = (entry) => { setWorkingId(entry.set.id); setTab('grid'); };

  // Undo: a new draft from the version, opened in Publish.
  const [undo, setUndo] = useState(null);       // { version, plan }
  const startUndo = (v) => setUndo({ version: v, plan: undoChanges(v, live, Object.fromEntries([...names.products, ...names.sites])) });
  const confirmUndo = async () => {
    const { version, plan } = undo;
    setBusy(`undo:${version.id}`);
    const d = await api.createDraft(menu.id, `Undo version ${version.version_no}${version.title ? `: ${version.title}` : ''}`.slice(0, 80), 'undo', { undoOf: version.id });
    if (!d.ok) { setBusy(''); setNote({ tone: 'bad', text: d.words }); return; }
    const r = await api.stageMany(d.data.id, withBefore(live, plan.changes), []);
    setBusy('');
    await refreshSets();
    setWorkingId(d.data.id);
    setUndo(null);
    if (!r.ok) { setNote({ tone: 'bad', text: `The undo draft was made but ${r.failed.length || r.conflicts} change${(r.failed.length || r.conflicts) === 1 ? '' : 's'} did not go in: ${r.failed[0]?.words || 'someone changed them at the same moment'}.` }); return; }
    setNote({ tone: 'good', text: `The undo is a draft: check what it changes at each site, then publish it or schedule it.` });
    setTab('publish');
  };

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 1080 }}>
      {history.error && <Notice tone="bad">{history.error}</Notice>}

      <div>
        <SectionHead title="Coming up" sub="Scheduled sets run by themselves at their time, in this order. A set starts a few minutes early so it is on every till by its time." />
        {!entries.length && (
          <div style={{ ...ui.card, ...ui.sub }}>
            Nothing is scheduled. In Publish, pick "At a date and time" to put changes on the tills later, for example new products on the tills by Monday 06:00.
          </div>
        )}
        <div style={{ display: 'grid', gap: 12 }}>
          {entries.map((e) => {
            const sum = e.version ? versionSummary(e.version, siteNames, now) : null;
            const local = e.set.run_local ? String(e.set.run_local).replace(' ', 'T') : null;
            const at = e.firstDue != null ? e.firstDue + (e.set.lead_minutes || 0) * 60000 : null;
            const tz = tzOf(e.sites[0]?.location_id);
            const changeable = canEdit && canStillChange(e);
            return (
              <div key={e.set.id} style={{ ...ui.card, display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 16 }}>
                <div style={{ borderRight: '1px solid var(--bdr)', paddingRight: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>On the tills by</div>
                  <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.02em', marginTop: 4 }}>{at != null ? clockText(at, tz) : '…'}</div>
                  <div style={{ fontSize: 13, fontWeight: 650 }}>{at != null ? whenText(at, tz).replace(/ \d\d:\d\d$/, '') : local}</div>
                  <div style={{ ...ui.sub, marginTop: 6 }}>{e.set.status === 'running' ? 'Running now' : countdownWords(e.firstDue, now)}</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...ui.row, marginBottom: 4 }}>
                    <div style={{ fontSize: 15, fontWeight: 750, flex: 1 }}>{e.set.title}</div>
                    {sum && <Pill tone={sum.tone}>{sum.head}</Pill>}
                  </div>
                  <div style={ui.sub}>
                    {changesOf[e.set.id] ? `${changesOf[e.set.id].length} change${changesOf[e.set.id].length === 1 ? '' : 's'} · ` : ''}
                    {e.sites.length} site{e.sites.length === 1 ? '' : 's'}
                    {e.set.lead_minutes ? ` · starts ${e.firstDue != null ? clockText(e.firstDue, tz) : ''}` : ''}
                    {e.set.apply_when_idle === false ? ' · counter tills show Sync POS' : ' · counter tills update between sales'}
                  </div>
                  {sum?.willFail?.length > 0 && <div style={{ marginTop: 8 }}><Notice tone="bad">{sum.willFail.map((w) => `${w.name} will fail: ${w.words}`).join(' ')} Fix it before then, or unschedule and take that site out.</Notice></div>}
                  {sum?.late?.length > 0 && <div style={{ marginTop: 8 }}><Notice tone="bad">{sum.detail}</Notice></div>}
                  {(overlapBy.get(e.set.id) || []).map((w) => <div key={w} style={{ marginTop: 8 }}><Notice>{w}</Notice></div>)}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                    {e.sites.map((s) => (
                      <span key={s.location_id} title={siteRowWords(s, tzOf(s.location_id), now)} style={{ fontSize: 11.5, padding: '3px 8px', borderRadius: 8, background: 'var(--bg2)', border: `1px solid ${s.status === 'failed' || s.precheck_ok === false ? 'var(--red-b)' : 'var(--bdr)'}`, color: 'var(--t2)' }}>
                        {siteNames[s.location_id] || 'One site'}: {s.status === 'scheduled' ? clockText(Date.parse(s.due_at), tzOf(s.location_id)) : (s.status === 'done' || s.status === 'nothing') ? 'done' : s.status}
                      </span>
                    ))}
                  </div>
                  <div style={{ ...ui.row, marginTop: 12 }}>
                    <Btn small kind="soft" onClick={() => view(e)}>View the menu as it will be</Btn>
                    {changeable && <Btn small disabled={busy === e.set.id} onClick={() => stop(e, 'unschedule')}>Unschedule to change it</Btn>}
                    {changeable && <Btn small kind="danger" disabled={busy === e.set.id} onClick={() => stop(e, 'cancel')}>Cancel</Btn>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <SectionHead title="History" sub="Every publish is a version. Open one to see what it wrote at each site. Undo makes a new draft that puts it back, with the same preview first." />
        {!history.rows && !history.error && <div style={ui.sub}>Reading…</div>}
        {history.rows && !past.length && <div style={{ ...ui.card, ...ui.sub }}>Nothing published yet.</div>}
        <div style={{ ...ui.card, padding: 0, overflow: 'hidden' }}>
          {past.map((v, i) => (
            <VersionRow key={v.id} v={v} first={i === 0} api={api} names={names} siteNames={siteNames} tzOf={tzOf} now={now} live={live}
              canEdit={canEdit} busy={busy} setBusy={setBusy} setNote={setNote} onRefresh={history.refresh} onUndo={() => startUndo(v)} />
          ))}
        </div>
      </div>

      {undo && (
        <Modal title={`Undo version ${undo.version.version_no}`} sub={undo.version.title || ''} width={620} onClose={() => setUndo(null)}
          footer={(
            <>
              <div style={{ flex: 1, ...ui.sub }}>{undo.plan.changes.length} change{undo.plan.changes.length === 1 ? '' : 's'} go into a new draft. Nothing reaches the tills until you publish it.</div>
              <Btn onClick={() => setUndo(null)}>Keep it as it is</Btn>
              <Btn kind="primary" disabled={!undo.plan.changes.length || busy === `undo:${undo.version.id}`} onClick={confirmUndo}>Make the undo draft</Btn>
            </>
          )}>
          {!undo.plan.changes.length && <Notice>There is nothing in this version that can be put back.</Notice>}
          {undo.plan.warnings.map((w) => <div key={w} style={{ marginBottom: 8 }}><Notice>{w}</Notice></div>)}
          {undo.plan.skipped.map((w) => <div key={w} style={{ marginBottom: 8 }}><Notice tone="bad">{w}</Notice></div>)}
          <WindowedList items={withBefore(live, undo.plan.changes)} rowHeight={30} height={300} renderRow={(c) => {
            const w = changeWords(c, names);
            return <div style={{ fontSize: 13, borderBottom: '1px solid var(--bdr)', height: '100%', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}><strong>{w.subject}</strong><span style={{ color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.words}</span></div>;
          }} />
        </Modal>
      )}
    </div>
  );
}

function SectionHead({ title, sub }) {
  return (
    <div style={{ margin: '0 0 10px' }}>
      <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.01em' }}>{title}</div>
      <div style={ui.sub}>{sub}</div>
    </div>
  );
}

// One version: the summary line, and when opened each site's result and what it wrote there.
function VersionRow({ v, first, api, names, siteNames, tzOf, now, live, canEdit, busy, setBusy, setNote, onRefresh, onUndo }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);       // Map(loc -> writes) | 'error'
  const [site, setSite] = useState(null);
  const sum = versionSummary(v, siteNames, now);
  const when = v.finished_at || v.started_at || v.created_at;
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      const r = await api.versionDetail(v.id);
      setDetail(r.rows ? new Map(r.rows.map((x) => [x.location_id, x.writes || []])) : 'error');
    }
  };
  const retry = async (loc) => {
    setBusy(`${v.id}|${loc}`);
    const r = await api.retrySite(v.id, loc);
    setBusy('');
    if (!r.ok) setNote({ tone: 'bad', text: r.words });
    else setNote({ tone: 'good', text: `${siteNames[loc] || 'The site'} is being tried again, with the group menu as it is now.` });
    await onRefresh();
  };
  // Venue ids to the group's names, for the audit lines.
  const vnames = useMemo(() => {
    const m = new Map();
    for (const ps of live?.productSites || []) m.set(ps.venue_item_id, names.products.get(ps.product_id));
    for (const cs of live?.catSites || []) m.set(cs.venue_category_id, names.categories.get(cs.category_id));
    return m;
  }, [live, names]);
  const lines = useMemo(() => {
    if (!detail || detail === 'error') return [];
    const loc = site || v.sites[0]?.location_id;
    return auditLines(detail.get(loc) || [], vnames);
  }, [detail, site, v.sites, vnames]);
  const central = (v.changes || []).map((c) => changeWords(c, names));
  const canUndo = canEdit && ['done', 'partly_done'].includes(v.status) && v.kind !== 'import' && (v.changes || []).length > 0;

  return (
    <div style={{ borderTop: first ? 'none' : '1px solid var(--bdr)' }}>
      <div onClick={toggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') toggle(); }} style={{ ...ui.row, padding: '12px 16px', cursor: 'pointer' }}>
        <span style={{ width: 54, fontSize: 12, fontWeight: 800, color: 'var(--t3)' }}>{v.version_no ? `v${v.version_no}` : ''}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.title || KIND[v.kind] || 'Publish'}</div>
          <div style={ui.sub}>
            {KIND[v.kind] || v.kind}{when ? ` · ${new Date(when).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}{v.created_by_name ? ` · ${v.created_by_name}` : ''}
          </div>
        </div>
        <Pill tone={sum.tone}>{sum.head}</Pill>
        <span style={{ color: 'var(--t4)', fontSize: 12, width: 14 }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 16px 16px 70px', display: 'grid', gap: 12 }}>
          {sum.detail && <div style={ui.sub}>{sum.detail}</div>}
          {v.sites.length > 0 && (
            <div>
              <span style={ui.label}>Each site</span>
              {v.sites.map((s) => (
                <div key={s.location_id} style={{ ...ui.row, padding: '5px 0', fontSize: 13 }}>
                  <button type="button" onClick={() => setSite(s.location_id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, color: (site || v.sites[0]?.location_id) === s.location_id ? 'var(--acc)' : 'var(--t1)', fontSize: 13 }}>{siteNames[s.location_id] || 'One site'}</button>
                  <span style={{ flex: 1, color: s.status === 'failed' ? 'var(--red)' : 'var(--t3)', fontSize: 12.5 }}>{siteRowWords(s, tzOf(s.location_id), now)}</span>
                  {canEdit && s.status === 'failed' && <Btn small kind="soft" disabled={busy === `${v.id}|${s.location_id}`} onClick={() => retry(s.location_id)}>Retry {siteNames[s.location_id] || ''}</Btn>}
                </div>
              ))}
            </div>
          )}
          {v.kind !== 'import' && (
            <div>
              <span style={ui.label}>What it wrote at {siteNames[site || v.sites[0]?.location_id] || 'the site'}</span>
              {detail === 'error' && <Notice tone="bad">Could not read what it wrote.</Notice>}
              {!detail && <div style={ui.sub}>Reading…</div>}
              {detail && detail !== 'error' && (
                <WindowedList items={lines} rowHeight={28} height={240} empty={<div style={ui.sub}>Nothing was written at this site.</div>}
                  renderRow={(l) => <div style={{ fontSize: 12.5, color: 'var(--t2)', borderBottom: '1px solid var(--bdr)', height: '100%', display: 'flex', alignItems: 'center' }}>{l}</div>} />
              )}
            </div>
          )}
          {central.length > 0 && (
            <div>
              <span style={ui.label}>In the group menu</span>
              <WindowedList items={central} rowHeight={28} height={200} renderRow={(w) => (
                <div style={{ fontSize: 12.5, borderBottom: '1px solid var(--bdr)', height: '100%', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}><strong>{w.subject}</strong><span style={{ color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.words}</span></div>
              )} />
            </div>
          )}
          {canUndo && <div><Btn small onClick={onUndo}>Undo this version…</Btn></div>}
        </div>
      )}
    </div>
  );
}
