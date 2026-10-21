/**
 * Stock items > Copy a site (multi site stock Drop 1): pick the new site and the site to copy.
 * Every item, supplier link and par of the site you copy from is ticked at the new site, on hand
 * 0 (stock_copy_site, always done by the save queue; account numbers and order emails are left for
 * the new site to fill, recipes come with the recipe update). The progress shows here.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { pollJobs } from '../../../../lib/stock/companyData';
import { copySiteCheck, importProgressWords } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, Field, Notice, ui } from '../stockUi';

export default function CopySiteModal({ sites, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    if (jobId == null) return undefined;
    const stop = pollJobs(stockApi, [jobId], (rows) => setJob((rows || [])[0] || null));
    return () => { if (typeof stop === 'function') stop(); };
  }, [jobId, again]);

  const name = (id) => (sites || []).find((s) => s.id === id)?.name || 'the site';
  const copy = async () => {
    const bad = copySiteCheck(from, to);
    if (bad) { setError(bad); return; }
    setBusy(true); setError('');
    const r = await stockApi.copySite(from, to);
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    const id = r.data?.queue_id ?? r.queued?.[0]?.job_id ?? null;
    try { showToast?.(`Copying ${name(from)} to ${name(to)}. It runs in the background.`, 'info'); } catch { /* no toast, no harm */ }
    if (id == null) { onClose?.(); return; }
    setJob(null);
    setJobId(id);
    setAgain((n) => n + 1);
  };

  const running = jobId != null && job?.status !== 'done' && job?.status !== 'failed';
  return (
    <Modal title="Copy a site" onClose={onClose} width={520} dirty={!jobId && (!!from || !!to)}
      footer={<>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose}>{jobId ? 'Close' : 'Cancel'}</Btn>
        {!jobId && <Btn kind="primary" disabled={busy || !!copySiteCheck(from, to)} onClick={copy}>{busy ? 'Starting…' : 'Copy'}</Btn>}
      </>}>
      <Field label="New site">
        <select value={to} onChange={(e) => setTo(e.target.value)} disabled={!!jobId} aria-label="New site" style={ui.input}>
          <option value="">Pick the new site</option>
          {(sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Site to copy">
        <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={!!jobId} aria-label="Site to copy" style={ui.input}>
          <option value="">Pick the site to copy</option>
          {(sites || []).filter((s) => s.id !== to).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <div style={ui.sub}>Every item, supplier link and par of the site you copy from is ticked at the new site. On hand starts at 0.</div>
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
      {jobId != null && (
        <div style={{ marginTop: 12 }}>
          {job?.status === 'failed'
            ? <Notice tone="bad" actions={[{ label: 'Try again', onClick: () => { setJobId(null); setJob(null); copy(); } }]}>{name(to)} did not finish: {String(job.last_error || 'it stopped').replace(/\.\s*$/, '')}.</Notice>
            : <Notice tone={job?.status === 'done' ? 'good' : 'info'}>{job?.status === 'done' ? `Done. ${name(to)} now has what ${name(from)} stocks, on hand 0.` : `Copying: ${importProgressWords(job) || 'waiting to start'}.`}</Notice>}
          {running && <div style={{ ...ui.sub, marginTop: 6 }}>You can close this. The copy keeps going.</div>}
        </div>
      )}
    </Modal>
  );
}
