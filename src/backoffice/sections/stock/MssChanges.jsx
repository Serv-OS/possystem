// src/backoffice/sections/stock/MssChanges.jsx
//
// MULTI SITE STOCK (v5.11.80): Review and publish (plan 5.2 "Changes, preview and publish").
//   * The draft, in words, with Remove for any one change or all of them.
//   * Preview: per site, in words ("Leeds: 42 new stock items, 3 suppliers, 120 prices. No stock
//     quantities change."), and the health check: what stops the publish and what to look at.
//   * Publish tonight (05:00 on each site's own clock, the default) or Publish now.
//   * Site cards: "Stock in step" or what waits; Show differences (the site's value and the
//     company's side by side) with Keep the site's (the row becomes the site's own) or Put the
//     company's back (the next publish writes it).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Btn, Pill, Notice, ConfirmDialog, Modal } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';
import { planWords, healthLines, siteCardWords, changeWords, costLines, showDiscardAll, FIELD_WORDS } from '../../../lib/stock/company/stockCompanyRules';
import { t, fmtWhen } from './mssShared';

export default function MssChanges({ api, orgId, canEdit, sites, draft, draftErr, refreshDraft, setNote, bump, reload }) {
  // the Review list is a page from the server with names (never the raw draft rows, never ids)
  const [page, setPage] = useState({ total: null, rows: [] });
  const [pageErr, setPageErr] = useState('');
  useEffect(() => {
    let live = true;
    api.draftRows(orgId, { limit: 300 }).then((r) => {
      if (!live) return;
      if (r.ok) { setPage({ total: Number(r.data?.total) || 0, rows: r.data?.rows || [] }); setPageErr(''); } else setPageErr(r.words);
    });
    return () => { live = false; };
  }, [api, orgId, draft, reload]);
  const total = page.total != null ? page.total : draft.length;
  // { rows: [{ location_id, name, plan, health }], done, total, error, draft }: a preview is shown only for the draft it was made from
  const [previewState, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null);       // 'now' | 'night' | 'discard'
  const [cards, setCards] = useState([]);
  const [drift, setDrift] = useState(null);         // { site, data }
  const loadCards = useCallback(() => api.siteCards(orgId).then((r) => { if (r.ok) setCards(r.data || []); }), [api, orgId]);
  useEffect(() => { loadCards(); }, [loadCards, reload]);
  const preview = previewState && previewState.draft === draft ? previewState : null;

  const runPreview = async () => {
    setBusy(true);
    const ids = sites.map((s) => s.id);
    const out = [];
    let error = null;
    for (let i = 0; i < ids.length; i += 5) {
      const r = await api.preview(orgId, ids.slice(i, i + 5));
      if (!r.ok || r.data?.ok === false) { error = r.words || r.data?.error; break; }
      out.push(...(r.data?.sites || []));
      setPreview({ rows: [...out], done: Math.min(i + 5, ids.length), total: ids.length, draft });
    }
    setPreview({ rows: out, done: out.length, total: ids.length, error, draft });
    setBusy(false);
  };
  const blocks = useMemo(() => (preview?.rows || []).flatMap((s) => healthLines(s.health).blocks), [preview]);
  const publish = async (when) => {
    setAsking(null); setBusy(true);
    const r = await api.publish(orgId, when);
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setNote({ tone: 'good', text: when === 'now'
      ? `Version ${r.data.version_no} published: each site is written within about a minute, one site at a time. History shows each site.`
      : `Version ${r.data.version_no} is scheduled for 05:00 on each site's own clock. History shows each site; Run now is there if you need it sooner.` });
    await refreshDraft(); bump();
  };
  const discardAll = async () => {
    setAsking(null);
    const r = await api.unstage(orgId, null);
    if (!r.ok) setNote({ tone: 'bad', text: r.words }); else { setNote({ tone: 'good', text: 'The draft is empty again.' }); refreshDraft(); }
  };
  const removeOne = async (c) => {
    const r = await api.unstage(orgId, [c.id]);
    if (!r.ok) setNote({ tone: 'bad', text: r.words }); else refreshDraft();
  };
  const showDrift = async (card) => {
    const r = await api.siteDrift(orgId, card.location_id);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setDrift({ site: card, data: r.data });
  };
  const runNow = async (card) => {
    const v = card.waiting;
    const h = await api.history(orgId, { limit: 20 });
    const version = (h.data?.rows || []).find((x) => x.version_no === v.version_no);
    if (!version) return;
    const r = await api.runNow(orgId, version.id);
    if (!r.ok) setNote({ tone: 'bad', text: r.words }); else { setNote({ tone: 'good', text: `Version ${v.version_no} runs within a minute.` }); loadCards(); }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={ui.card}>
        <div style={{ ...ui.row, marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ ...ui.h2, flex: 1 }}>The draft: {total} change{total === 1 ? '' : 's'}</div>
          <Btn onClick={runPreview} disabled={busy || !total}>{busy ? 'Working…' : 'Preview every site'}</Btn>
          {canEdit && <Btn kind="primary" disabled={busy || !total || !preview || preview.error || blocks.length > 0 || preview.done < preview.total} onClick={() => setAsking('night')}>Publish tonight</Btn>}
          {canEdit && <Btn disabled={busy || !total || !preview || preview.error || blocks.length > 0 || preview.done < preview.total} onClick={() => setAsking('now')}>Publish now</Btn>}
          {/* Discard all stays even when the draft cannot be read (too big, or a failed read) */}
          {showDiscardAll({ canEdit, total, readError: draftErr || pageErr }) && <Btn kind="danger" onClick={() => setAsking('discard')}>Discard all</Btn>}
        </div>
        {(draftErr || pageErr) && <div style={{ marginBottom: 8 }}><Notice tone="bad">Could not read the whole draft ({draftErr || pageErr}). Discard all still empties it.</Notice></div>}
        {!total && !draftErr && <div style={ui.sub}>Nothing in the draft. Edits in Stock items and Suppliers and prices land here first.</div>}
        {total > 0 && !preview && <div style={{ ...ui.sub, marginBottom: 8 }}>Preview first: it shows what each site gets and anything that would stop the publish.</div>}
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {page.rows.map((c) => (
            <div key={c.id} style={{ ...ui.row, padding: '5px 0', borderTop: '1px solid var(--bdr)', fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>{changeWords(c)}</span>
              {canEdit && <Btn small onClick={() => removeOne(c)}>Remove</Btn>}
            </div>
          ))}
          {total > page.rows.length && <div style={t.grey}>and {total - page.rows.length} more</div>}
        </div>
      </div>

      {preview && (
        <div style={ui.card}>
          <div style={{ ...ui.h2, marginBottom: 8 }}>Preview{preview.done < preview.total ? ` (${preview.done} of ${preview.total} sites)` : ''}</div>
          {preview.error && <Notice tone="bad">{preview.error}</Notice>}
          {blocks.length > 0 && <div style={{ marginBottom: 8 }}><Notice tone="bad">This stops the publish: {blocks.join(' ')}</Notice></div>}
          {(preview.rows || []).map((s) => {
            const h = healthLines(s.health);
            return (
              <div key={s.location_id} style={{ padding: '7px 0', borderTop: '1px solid var(--bdr)', fontSize: 13 }}>
                <div>{planWords(s.name, s.plan)}</div>
                {costLines(s.plan).length > 0 && <div style={t.grey}>Cost here, before and after: {costLines(s.plan).join('; ')}{Number(s.plan?.costs_changed) > costLines(s.plan).length ? `; and ${Number(s.plan.costs_changed) - costLines(s.plan).length} more` : ''}.</div>}
                {h.warns.map((w) => <div key={w} style={{ ...t.grey, color: 'var(--amber, #F5A623)' }}>{w}</div>)}
                {h.blocks.map((w) => <div key={w} style={{ ...t.grey, color: 'var(--red)' }}>{w}</div>)}
              </div>
            );
          })}
        </div>
      )}

      <div style={ui.card}>
        <div style={{ ...ui.h2, marginBottom: 8 }}>Sites</div>
        <table style={t.table}>
          <thead><tr><th style={t.th}>Site</th><th style={t.th}>Items on</th><th style={t.th}>Stock</th><th style={t.th}>Central stock</th><th style={t.th} /></tr></thead>
          <tbody>
            {cards.map((c) => {
              const w = siteCardWords(c, fmtWhen);
              return (
                <tr key={c.location_id}>
                  <td style={t.td}><b>{c.name}</b></td>
                  <td style={t.td}>{c.items}</td>
                  <td style={t.td}><Pill tone={w.tone}>{w.words}</Pill></td>
                  <td style={{ ...t.td, ...t.grey }}>{c.central === 'central' ? 'On' : c.central === 'paused' ? 'Paused by ServOS' : 'Off'}</td>
                  <td style={t.td}>
                    <Btn small onClick={() => showDrift(c)}>Show differences</Btn>
                    {canEdit && c.waiting && c.waiting.status !== 'running' && <Btn small style={{ marginLeft: 6 }} onClick={() => runNow(c)}>Run now</Btn>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {drift && <DriftView api={api} orgId={orgId} canEdit={canEdit} drift={drift} setNote={setNote} refreshDraft={refreshDraft} onClose={() => setDrift(null)} />}
      {asking === 'now' && <ConfirmDialog title="Publish now?" yes="Publish now" onNo={() => setAsking(null)} onYes={() => publish('now')}
        words={'Each site is written within about a minute, one at a time. A site that is busy (a sale holding a stock item) gives way and tries again the next minute, so tills are never held for more than 2 seconds.\nNo stock quantity, cost or count changes.'} />}
      {asking === 'night' && <ConfirmDialog title="Publish tonight?" yes="Publish at 05:00" onNo={() => setAsking(null)} onYes={() => publish('night')}
        words="Each site is written at 05:00 on its own clock, outside trading. Until then the change waits; History shows it and has Run now." />}
      {asking === 'discard' && <ConfirmDialog title="Discard the whole draft?" danger yes="Discard it" onNo={() => setAsking(null)} onYes={discardAll}
        words="Every staged change is thrown away. Nothing at any site changes." />}
    </div>
  );
}

const show = (k, v) => (v == null ? '' : k === 'archived_at' ? fmtWhen(v) : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const label = (k) => { const w = FIELD_WORDS[k] || k.replace(/_/g, ' '); return w.charAt(0).toUpperCase() + w.slice(1); };

function DriftView({ api, orgId, canEdit, drift, setNote, refreshDraft, onClose }) {
  const rows = drift.data?.detail || [];
  const keep = async (r) => {
    const res = await api.keepSite(orgId, drift.site.location_id, r.kind === 'price' ? 'price' : r.kind, r.company_id);
    if (!res.ok) setNote({ tone: 'bad', text: res.words }); else { setNote({ tone: 'good', text: `${r.name} is ${drift.site.name}'s own now. Undo is in History.` }); onClose(); }
  };
  const putBack = async () => {
    // any staged change makes the next publish write every difference back (the planner writes
    // the company's values wherever they differ)
    const first = rows.find((r) => r.company_id);
    if (!first) return;
    const target = first.kind === 'item' ? 'item' : first.kind === 'supplier' ? 'supplier' : 'sp';
    const r = await api.stage(orgId, [{ target, entity_id: first.company_id, data: {} }]);
    if (!r.ok) setNote({ tone: 'bad', text: r.words });
    else { setNote({ tone: 'good', text: `The next publish puts the company's values back at ${drift.site.name}.` }); refreshDraft(); onClose(); }
  };
  return (
    <Modal title={`${drift.site.name}: what a publish would change`} sub={`${drift.data?.writes || 0} rows differ. The site's value is on the left, the company's on the right.`} onClose={onClose} width={900}
      footer={canEdit && rows.length ? <Btn kind="primary" onClick={putBack}>Put the company's back (next publish)</Btn> : null}>
      {!rows.length && <div style={ui.sub}>Stock in step: nothing differs here.</div>}
      {rows.map((r) => {
        const keys = Object.keys(r.company || {}).filter((k) => !/_id$/.test(k) && JSON.stringify(r.site?.[k] ?? null) !== JSON.stringify(r.company?.[k] ?? null));
        return (
          <div key={`${r.kind}-${r.row_id}`} style={{ padding: '8px 0', borderTop: '1px solid var(--bdr)' }}>
            <div style={{ ...ui.row, marginBottom: 4 }}>
              <b style={{ flex: 1 }}>{r.name} <span style={t.grey}>({{ item: 'stock item', supplier: 'supplier', price: 'supplier price' }[r.kind] || 'row'}{r.linking ? ', joining the company row' : ''}{r.site_changed_at ? `, last changed at the site ${fmtWhen(r.site_changed_at, drift.site.timezone || undefined)}` : ''})</span></b>
              {canEdit && !r.linking && r.company_id && <Btn small onClick={() => keep(r)}>Keep the site's</Btn>}
            </div>
            <table style={t.table}><tbody>
              {keys.map((k) => <tr key={k}><td style={{ ...t.td, width: 160, ...t.grey }}>{label(k)}</td><td style={t.td}>{show(k, r.site?.[k]) || 'none'}</td><td style={t.td}><b>{show(k, r.company?.[k]) || 'none'}</b></td></tr>)}
            </tbody></table>
          </div>
        );
      })}
    </Modal>
  );
}
