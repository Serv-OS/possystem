// src/backoffice/sections/stock/MssHistory.jsx
//
// MULTI SITE STOCK (v5.11.80): History and Undo (plan 4.11, 5.2). Every version: who, when, each
// site's status, what it wrote (one before and after row per changed row). The newest live version
// can be undone: company rows come back at once; at each site it reached, the rows it changed are put
// back and the rows it added (and nothing has used since) are removed, the rest archived and handed to
// the site. Undo never touches on hand, cost or the ledger.

import { useCallback, useEffect, useState } from 'react';
import { Btn, Pill, Modal, ConfirmDialog } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';
import { versionWords } from '../../../lib/stock/company/stockCompanyRules';
import { t, fmtWhen } from './mssShared';
import { Pager } from './mssCommon';

const SITE_TONE = { done: 'good', nothing: 'neutral', waiting: 'warn', running: 'blue', failed: 'bad', cancelled: 'neutral' };
const SITE_WORDS = { done: 'written', nothing: 'nothing to change', waiting: 'waiting', running: 'writing now', failed: 'failed', cancelled: 'cancelled' };
const TBL = { inventory_items: 'Stock item', item_packaging_formats: 'Pack', inventory_item_conversions: 'Unit bridge', suppliers: 'Supplier',
  supplier_products: 'Supplier price', inventory_item_areas: 'Area' };

export default function MssHistory({ api, orgId, canEdit, setNote, bump, refreshDraft, reload }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [asking, setAsking] = useState(null);
  const [detail, setDetail] = useState(null);   // { version, site, rows, total }
  const load = useCallback(() => api.history(orgId, { offset, limit: 50 }).then((r) => {
    if (r.ok) { setRows(r.data?.rows || []); setTotal(Number(r.data?.total) || 0); } else setNote({ tone: 'bad', text: r.words });
  }), [api, orgId, offset, setNote]);
  useEffect(() => { load(); }, [load, reload]);
  // the newest version that is not an undo and not undone: the one Undo works on
  const newest = rows.find((v) => v.kind !== 'undo' && v.status !== 'undone');
  const undo = async (v) => {
    setAsking(null);
    const r = await api.undo(orgId, v.id);
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setNote({ tone: 'good', text: `Version ${v.version_no} undone at head office. ${r.data.sites ? `${r.data.sites} site${r.data.sites === 1 ? ' is' : 's are'} put back within about a minute.` : 'No site had it yet.'}` });
    bump(); refreshDraft(); load();
  };
  const runNow = async (v) => {
    const r = await api.runNow(orgId, v.id);
    if (!r.ok) setNote({ tone: 'bad', text: r.words }); else { setNote({ tone: 'good', text: `Version ${v.version_no} runs within a minute.` }); load(); }
  };
  const open = async (v, site) => {
    const r = await api.versionRows(orgId, v.id, site.location_id, { limit: 200 });
    if (!r.ok) { setNote({ tone: 'bad', text: r.words }); return; }
    setDetail({ version: v, site, rows: r.data?.rows || [], total: Number(r.data?.total) || 0 });
  };
  return (
    <div>
      <div style={t.bar}><div style={{ ...ui.h2, flex: 1 }}>Every version</div><Pager offset={offset} limit={50} total={total} onChange={setOffset} /><Btn small onClick={load}>Refresh</Btn></div>
      {!rows.length && <div style={ui.sub}>Nothing published yet.</div>}
      {rows.map((v) => (
        <div key={v.id} style={{ ...ui.card, padding: 14, marginBottom: 10 }}>
          <div style={{ ...ui.row, flexWrap: 'wrap' }}>
            <b>Version {v.version_no}</b>
            <span style={ui.sub}>{versionWords(v)}{v.note ? ` · ${v.note}` : ''} · {v.created_by_name || 'someone'} · {fmtWhen(v.created_at)}</span>
            <span style={{ flex: 1 }} />
            {canEdit && v.status === 'waiting' && <Btn small onClick={() => runNow(v)}>Run now</Btn>}
            {canEdit && newest && newest.id === v.id && <Btn small kind="danger" onClick={() => setAsking(v)}>Undo</Btn>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {(v.sites || []).map((s) => (
              <button key={s.location_id} type="button" onClick={() => open(v, s)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                title={s.last_error || (s.status === 'waiting' ? `due ${fmtWhen(s.due_at)}` : '')}>
                <Pill tone={SITE_TONE[s.status] || 'neutral'}>{s.name}: {SITE_WORDS[s.status] || s.status}{s.writes ? ` (${s.writes})` : ''}</Pill>
              </button>
            ))}
          </div>
        </div>
      ))}
      {asking && (
        <ConfirmDialog title={`Undo version ${asking.version_no}?`} danger yes="Undo it" onNo={() => setAsking(null)} onYes={() => undo(asking)}
          words={'Head office\'s rows go back at once. Each site it reached is put back within about a minute: changed rows get their old values, rows it added are removed (or archived and kept by the site when something already uses them).\nNo stock quantity, cost or count changes.'} />
      )}
      {detail && (
        <Modal title={`Version ${detail.version.version_no} at ${detail.site.name}`} sub={`${detail.total} row${detail.total === 1 ? '' : 's'} written${detail.total > 200 ? ' (first 200 shown)' : ''}`} onClose={() => setDetail(null)} width={860}>
          <table style={t.table}>
            <thead><tr><th style={t.th}>What</th><th style={t.th}>How</th><th style={t.th}>Before</th><th style={t.th}>After</th></tr></thead>
            <tbody>
              {detail.rows.map((r) => (
                <tr key={`${r.tbl}-${r.row_id}`}>
                  <td style={t.td}>{TBL[r.tbl] || r.tbl}</td>
                  <td style={t.td}>{r.op}</td>
                  <td style={{ ...t.td, ...t.grey, maxWidth: 300, wordBreak: 'break-word' }}>{r.before ? Object.entries(r.before).filter(([k]) => k !== 'updated_at').map(([k, val]) => `${k}: ${JSON.stringify(val)}`).join('; ') : ''}</td>
                  <td style={{ ...t.td, maxWidth: 300, wordBreak: 'break-word' }}>{r.after ? Object.entries(r.after).map(([k, val]) => `${k}: ${JSON.stringify(val)}`).join('; ') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
