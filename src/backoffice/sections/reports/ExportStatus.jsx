// src/backoffice/sections/reports/ExportStatus.jsx
//
// MULTI SITE STOCK, Drop 4a (contract section 4, web-reports): the export flow every Stock report
// shares. Under 1,000 rows on screen (totals, the loaded drill rows, no next page) the CSV is built
// at once (exportCsvNow). Otherwise the database starts a job (stock_report_export_start), pg_cron
// and the report-export edge function build the file in slices, and this panel follows the job:
// 'Building your file: 12,000 rows so far', then 'Ready: <report> (<rows> rows)' with Download
// (the edge function streams the parts as one CSV; downloadExport carries the session JWT), Cancel
// while it runs, the job's own words when it failed, and 'Your exports' (the last 20, kept 7 days).
// Nothing is shown as ready before the database says done.

import { useEffect, useState } from 'react';
import { Btn, Pill, Notice, ErrorLine } from '../stock/stockUi';
import { exportCsvNow } from './_stockKit';
import { pollExport } from '../../../lib/stock/reportsData.js';
import { downloadExport } from '../../../lib/stock/exportDownload.js';
import { exportFileName } from '../../../lib/stock/reportRules.js';
import { allRowsLoaded, fmtInt, whenWords } from '../../../lib/stock/reportView.js';

export const KEPT_LINE = 'Files are kept for 7 days';
export const BUILDING_WORDS = (rows) => `Building your file: ${fmtInt(rows || 0)} rows so far`;
export const READY_WORDS = (label, rows) => `Ready: ${label} (${fmtInt(rows || 0)} rows)`;

const STATUS_WORDS = {
  waiting: 'Waiting to start',
  running: 'Building',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const jobOf = (rows, jobId) => {
  if (Array.isArray(rows)) return rows.find((j) => String(j.id) === String(jobId)) || rows[0] || null;
  return rows && typeof rows === 'object' ? rows : null;
};

const NOTHING = { jobId: null, job: null, error: null };

/**
 * The panel under a report while a background export runs, and after.
 *   api      stockReportsApi (exportJobs, exportCancel, myExports, exportDownloadUrl)
 *   jobId    the job to follow (null: only the 'Your exports' list)
 *   label    the report's title, for 'Ready: <report>'
 *   report   the function name without prefix, for the file name
 *   from, to the period, for the file name
 */
export default function ExportStatus({ api, jobId, label, report, from, to, onClose }) {
  // What the poll said, keyed by the job it was about: a new jobId reads as nothing until its first tick.
  const [polled, setPolled] = useState(NOTHING);
  const [busy, setBusy] = useState(null);         // null | 'download' | 'cancel'
  const [actError, setActError] = useState(null);
  const [showMine, setShowMine] = useState(false);
  const [mine, setMine] = useState(null);         // null = not read yet

  useEffect(() => {
    if (!jobId || !api) return undefined;
    const stop = pollExport(api, jobId, (rows, r) => {
      const j = jobOf(rows, jobId);
      const err = r?.error && !r?.needsUpdate ? r.error : (r?.needsUpdate ? (r.error || { needsUpdate: true }) : null);
      setPolled((p) => ({ jobId, job: j || (p.jobId === jobId ? p.job : null), error: err }));
    }, { everyMs: 3000 });
    return () => { if (typeof stop === 'function') stop(); };
  }, [api, jobId]);

  const job = polled.jobId === jobId ? polled.job : null;
  const pollError = polled.jobId === jobId ? polled.error : null;

  const readMine = async () => {
    setShowMine((v) => !v);
    if (mine != null || typeof api?.myExports !== 'function') return;
    const r = await api.myExports();
    setMine(Array.isArray(r?.data) ? r.data : []);
  };

  const download = async (j) => {
    setBusy('download');
    setActError(null);
    const url = typeof api?.exportDownloadUrl === 'function' ? api.exportDownloadUrl(j.id) : null;
    const r = url ? await downloadExport(url, exportFileName(j.report || report, from, to)) : { ok: false, error: new Error('This needs a ServOS update before files can be downloaded.') };
    if (!r?.ok) setActError(r?.error || new Error('The download did not finish. Try again.'));
    setBusy(null);
  };

  const cancel = async () => {
    setBusy('cancel');
    setActError(null);
    const r = await api.exportCancel(jobId);
    if (r?.error) setActError(r.error);
    setBusy(null);
  };

  const status = job?.status || null;
  const running = status === 'waiting' || status === 'running' || (!!jobId && !status && !pollError);
  const words = !jobId ? null
    : pollError ? null
    : running ? BUILDING_WORDS(job?.rows)
    : status === 'done' ? READY_WORDS(label || report, job?.rows)
    : status === 'failed' ? (job?.error || 'The export failed.')
    : status === 'cancelled' ? 'Export cancelled.'
    : status === 'expired' ? `This file has expired. ${KEPT_LINE}.`
    : '';
  const tone = status === 'failed' ? 'bad' : status === 'done' ? 'good' : 'info';

  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {jobId && words != null && (
        <Notice tone={tone} onClose={onClose}
          actions={[
            status === 'done' && { label: busy === 'download' ? 'Downloading' : 'Download', kind: 'primary', onClick: () => download(job), disabled: busy != null },
            running && { label: busy === 'cancel' ? 'Cancelling' : 'Cancel', kind: 'soft', onClick: cancel, disabled: busy != null },
          ]}>
          <span>{words}</span>
          {running && <span style={{ marginLeft: 8, color: 'var(--t3)' }}>{job?.pages ? `${fmtInt(job.pages)} pages` : 'It keeps building while you look at other screens.'}</span>}
          {status === 'done' && <span style={{ marginLeft: 8, color: 'var(--t3)' }}>{KEPT_LINE}.</span>}
        </Notice>
      )}
      {pollError && <ErrorLine error={pollError} />}
      {actError && <ErrorLine error={actError} />}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn kind="link" small onClick={readMine}>{showMine ? 'Hide your exports' : 'Your exports'}</Btn>
        <span style={{ fontSize: 12, color: 'var(--t4)' }}>{KEPT_LINE}</span>
      </div>
      {showMine && (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg1)', padding: '6px 10px' }}>
          {mine == null && <div style={{ fontSize: 13, color: 'var(--t3)', padding: '6px 0' }}>Reading your exports</div>}
          {mine && mine.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)', padding: '6px 0' }}>No exports yet.</div>}
          {mine && mine.map((j) => (
            <div key={j.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, minWidth: 120 }}>{j.report}</span>
              <Pill tone={j.status === 'done' ? 'good' : j.status === 'failed' ? 'bad' : 'neutral'}>{STATUS_WORDS[j.status] || j.status}</Pill>
              <span style={{ color: 'var(--t3)' }}>{fmtInt(j.rows)} rows</span>
              <span style={{ color: 'var(--t4)' }}>{whenWords(j.created_at)}</span>
              {j.status === 'failed' && j.error && <span style={{ color: 'var(--red)' }}>{j.error}</span>}
              {j.status === 'done' && <Btn kind="soft" small disabled={busy != null} onClick={() => download(j)}>Download</Btn>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one export decision every Stock report makes (contract section 4), as a hook:
 *   run()    under 1,000 rows on screen: the CSV at once; otherwise a background job
 *   panel    the ExportStatus element to render under the tables (null until a job starts)
 *   label    the report's title (file name and the Ready words)
 * args is the hook's call { orgId, sites, from, to, opts }; the job stores it exactly.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useExportFlow({ api, report, label, args, meta, totals, rows, next, onExport }) {
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const run = async () => {
    setError(null);
    if (!meta) return;
    if (allRowsLoaded(rows, next)) {
      exportCsvNow(report, meta, totals || [], rows || []);
      if (typeof onExport === 'function') onExport({ report, args, mode: 'now' });
      return;
    }
    if (typeof api?.exportStart !== 'function') { setError(new Error('This needs a ServOS update before big exports can run.')); setOpen(true); return; }
    const r = await api.exportStart(report, { org: args.orgId, sites: args.sites, from: args.from, to: args.to, opts: args.opts || {} });
    setOpen(true);
    if (r?.error) { setError(r.error); return; }
    const id = r?.data?.job_id || r?.data?.jobId || null;
    setJobId(id);
    if (typeof onExport === 'function') onExport({ report, args, mode: 'file', jobId: id });
  };
  const panel = open ? (
    <div>
      {error && <ErrorLine error={error} />}
      <ExportStatus api={api} jobId={jobId} label={label} report={report} from={args?.from} to={args?.to} onClose={() => { setOpen(false); setJobId(null); }} />
    </div>
  ) : null;
  return { run, jobId, error, panel, atOnce: allRowsLoaded(rows, next) };
}
