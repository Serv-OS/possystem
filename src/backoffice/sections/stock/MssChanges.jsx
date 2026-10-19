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
import { planWords, healthLines, siteCardWords } from '../../../lib/stock/company/stockCompanyRules';
import { t, fmtWhen } from './mssShared';

const TARGET_WORDS = { item: 'Stock item', item_site: 'Item at a site', pack: 'Pack', pack_site: 'Pack at a site', bridge: 'Unit bridge', bridge_site: 'Unit bridge at a site',
  supplier: 'Supplier', supplier_site: 'Supplier at a site', sp: 'Supplier price', sp_site: 'Price at a site' };
const describe = (c, siteName) => {
  const d = c.data || {};
  const what = Object.entries(d).filter(([k]) => k !== '_new').map(([k, v]) => {
    if (k === 'link') return 'link to the site\'s own row';
    if (k === 'active') return v == null ? 'follows every site' : (v ? 'on' : 'off');
    if (k === 'all_sites') return v ? 'on at every site' : 'not at every site';
    if (k === 'archived') return v ? 'archived' : 'brought back';
    return `${k.replace(/_/g, ' ')} ${Array.isArray(v) ? v.join(', ') : (v ?? 'cleared')}`;
  }).join(', ');
  return `${d._new ? 'New ' : ''}${TARGET_WORDS[c.target] || c.target}${d.name ? `: ${d.name}` : ''}${c.location_id ? ` at ${siteName(c.location_id)}` : ''}${what ? `: ${what}` : ''}`;
};

export default function MssChanges({ api, orgId, canEdit, sites, draft, refreshDraft, setNote, bump, reload }) {
  const siteName = useCallback((id) => sites.find((s) => s.id === id)?.name || 'a site', [sites]);
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
          <div style={{ ...ui.h2, flex: 1 }}>The draft: {draft.length} change{draft.length === 1 ? '' : 's'}</div>
          <Btn onClick={runPreview} disabled={busy || !draft.length}>{busy ? 'Working…' : 'Preview every site'}</Btn>
          {canEdit && <Btn kind="primary" disabled={busy || !draft.length || !preview || preview.error || blocks.length > 0 || preview.done < preview.total} onClick={() => setAsking('night')}>Publish tonight</Btn>}
          {canEdit && <Btn disabled={busy || !draft.length || !preview || preview.error || blocks.length > 0 || preview.done < preview.total} onClick={() => setAsking('now')}>Publish now</Btn>}
          {canEdit && draft.length > 0 && <Btn kind="danger" onClick={() => setAsking('discard')}>Discard all</Btn>}
        </div>
        {!draft.length && <div style={ui.sub}>Nothing in the draft. Edits in Stock items and Suppliers and prices land here first.</div>}
        {draft.length > 0 && !preview && <div style={{ ...ui.sub, marginBottom: 8 }}>Preview first: it shows what each site gets and anything that would stop the publish.</div>}
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {draft.slice(0, 300).map((c) => (
            <div key={c.id} style={{ ...ui.row, padding: '5px 0', borderTop: '1px solid var(--bdr)', fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>{describe(c, siteName)}</span>
              {canEdit && <Btn small onClick={() => removeOne(c)}>Remove</Btn>}
            </div>
          ))}
          {draft.length > 300 && <div style={t.grey}>and {draft.length - 300} more</div>}
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

const FIELD_WORDS = { name: 'Name', category: 'Category', accounting_group: 'Accounting group', base_unit: 'Base unit', allergens: 'Allergens', sku: 'SKU', barcode: 'Barcode',
  shelf_life_days: 'Shelf life', returns_to_shelf: 'Back on the shelf', purchase_tax_rate_id: 'VAT rate', archived_at: 'Archived', contact_name: 'Contact', phone: 'Phone',
  payment_terms_days: 'Terms', supplier_sku: 'Supplier SKU', pack_description: 'Pack', pack_qty: 'Packs', inner_qty: 'Holds', inner_unit: 'Unit', pack_price: 'Price',
  price_includes_tax: 'Includes VAT' };
const show = (v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

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
        const keys = Object.keys(r.company || {}).filter((k) => JSON.stringify(r.site?.[k] ?? null) !== JSON.stringify(r.company?.[k] ?? null));
        return (
          <div key={`${r.kind}-${r.row_id}`} style={{ padding: '8px 0', borderTop: '1px solid var(--bdr)' }}>
            <div style={{ ...ui.row, marginBottom: 4 }}>
              <b style={{ flex: 1 }}>{r.name} <span style={t.grey}>({r.kind}{r.linking ? ', joining the company row' : ''})</span></b>
              {canEdit && !r.linking && r.company_id && <Btn small onClick={() => keep(r)}>Keep the site's</Btn>}
            </div>
            <table style={t.table}><tbody>
              {keys.map((k) => <tr key={k}><td style={{ ...t.td, width: 160, ...t.grey }}>{FIELD_WORDS[k] || k}</td><td style={t.td}>{show(r.site?.[k])}</td><td style={t.td}><b>{show(r.company?.[k])}</b></td></tr>)}
            </tbody></table>
          </div>
        );
      })}
    </Modal>
  );
}
