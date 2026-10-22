// src/backoffice/sections/stock/OverviewAllSites.jsx
//
// MULTI SITE STOCK, Drop 1 (map 4.21, design 2.10 "Overview", contract 3.5 and 4.4): Inventory >
// Overview of a multi site company with the picker on All sites or a group. Every site at a glance:
//
//   Needs attention   one line per site with something to see (stock_needs_attention, 50 sites a
//                     call): below zero, no price, counts ready to approve, orders overdue, below
//                     reorder, saves that did not finish. Open moves the picker to that site.
//   Set up health     the sites the nightly check (stock_nightly_health) found out of step with the
//                     company list. Fix (company editors) queues a resync of that site
//                     (stock_resync_site), followed here until the save queue says done.
//   Go live           the sites whose go live plan still has steps left. Open moves the picker.
//   Company stock settings (CompanySettingsCard).
//
// Reads only, plus Fix (a queued job, never an inline write). Nothing here moves a number. A one
// site company never reaches this screen (StockOverview shows today's body).

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { normFocus } from '../../../lib/stock/stockAlertLinks';
import { stockApi } from '../../../lib/stock/stockApi';
import { pollJobs } from '../../../lib/stock/companyData';
import { attentionRows, healthRows, goLiveRows, siteChunks } from '../../../lib/stock/goLiveRules';
import { PageHead, Btn, ErrorLine, EmptyLine, ui } from './stockUi';
import CompanySettingsCard from './CompanySettingsCard';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };
const cardTitle = { fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 };
const line = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', flexWrap: 'wrap' };

// Every site's Needs attention row, 50 sites a call (the database refuses more). Never throws.
async function readAttention(orgId, ids) {
  const parts = siteChunks(ids);
  if (!orgId || !parts.length) return { rows: [], error: null };
  const answers = await Promise.all(parts.map((p) => stockApi.needsAttention(orgId, p)));
  const bad = answers.find((a) => a.error);
  return {
    rows: answers.flatMap((a) => (Array.isArray(a.data?.rows) ? a.data.rows : [])),
    // v5.11.96 (Drop 3): the purchasing, count, transfer, invoice and price rows, each with its route
    alerts: answers.flatMap((a) => (Array.isArray(a.data?.alerts) ? a.data.alerts : [])).filter((x) => x && x.route && x.words),
    error: bad ? bad.error : null,
  };
}

// The routes that work one site at a time: the picker moves to the alert's site before going there.
const SITE_ROUTES = new Set(['stock-counts', 'stock-transfers']);

// setSection and canOpen: the guarded route setter and the Back Office section rule, as today's
// Overview has them. Drop 1's cards only move the picker (Open) or queue a Fix, so neither is used
// yet; they are taken so Drop 4's Head office dashboard button (map 4.21) can ask canOpen first.
// eslint-disable-next-line no-unused-vars
export default function OverviewAllSites({ setSection, canOpen = () => true }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const canFix = sc.canEditCompany('inventory');
  const ids = (sc.scopeSites || []).map((s) => s.id).filter(Boolean);
  const loadKey = `${sc.orgId || ''}|${ids.join(',')}`;
  const [answer, setAnswer] = useState(null);   // { key, rows, error }
  const [fixing, setFixing] = useState({});     // { [locationId]: { busy, jobId, status, error } }
  const stops = useRef({});

  useEffect(() => {
    let live = true;
    const [orgId, list] = loadKey.split('|');
    readAttention(orgId, list ? list.split(',') : []).then((a) => { if (live) setAnswer({ key: loadKey, ...a }); });
    return () => { live = false; };
  }, [loadKey]);
  useEffect(() => {
    const running = stops.current;
    return () => { for (const stop of Object.values(running)) stop(); };
  }, []);

  const mine = answer && answer.key === loadKey ? answer : null;
  const rows = mine ? mine.rows : null;
  const error = mine ? mine.error : null;
  const alerts = mine ? (mine.alerts || []) : [];
  // Drop 3: an alert's button goes to its screen with the record to open (StockScope go and takeOpen)
  const follow = (a) => {
    if (SITE_ROUTES.has(a.route) && a.location_id) sc.setChoice({ kind: 'site', id: a.location_id });
    sc.go(a.route, { open: normFocus(a.route, a.focus) });
  };

  const open = (siteId) => sc.setChoice({ kind: 'site', id: siteId });

  const fix = async (row) => {
    const at = row.locationId;
    setFixing((f) => ({ ...f, [at]: { busy: true } }));
    const r = await stockApi.resyncSite(at);
    if (r.error) {
      setFixing((f) => ({ ...f, [at]: { busy: false, error: r.error.message || 'It did not start. Try again.' } }));
      showToast?.(r.error.message || 'It did not start. Try again.', 'error');
      return;
    }
    const jobId = r.data?.queue_id ?? null;
    setFixing((f) => ({ ...f, [at]: { busy: false, jobId, status: 'waiting' } }));
    if (jobId == null) return;
    stops.current[at]?.();
    stops.current[at] = pollJobs(stockApi, [jobId], (jobs) => {
      const j = jobs.find((x) => String(x.id) === String(jobId));
      if (j) setFixing((f) => ({ ...f, [at]: { busy: false, jobId, status: j.status, error: j.status === 'failed' ? (j.last_error || '') : null } }));
    });
  };

  const fixWords = (row) => {
    const f = fixing[row.locationId];
    if (!f || f.busy) return null;
    if (f.status === 'done') return 'Fixed. The next nightly check confirms it.';
    if (f.error && f.jobId == null) return f.error;   // the database refused to start it: its words
    if (f.status === 'failed' || f.error) return `${row.name} did not finish: ${f.error || 'no reason given'}.`;
    return 'Fixing. It runs in the background.';
  };

  const attention = attentionRows(rows);
  const health = healthRows(rows);
  const goLive = goLiveRows(rows);

  return (
    <div style={{ ...ui.page, height: '100%', overflowY: 'auto' }} data-testid="stock-overview-all-sites">
      <PageHead title="Stock control" sub="Every site at a glance." />
      <ErrorLine error={error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 18, alignItems: 'start' }}>
        <div style={card} data-testid="stock-needs-attention">
          <div style={cardTitle}>Needs attention</div>
          {rows === null && <EmptyLine>Loading{'…'}</EmptyLine>}
          {rows !== null && !error && attention.length === 0 && alerts.length === 0 && <EmptyLine>Nothing needs attention at any site.</EmptyLine>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {attention.map((a) => (
              <div key={a.locationId} style={line}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{a.words}</div>
                </div>
                <Btn small kind="soft" onClick={() => open(a.locationId)}>Open</Btn>
              </div>
            ))}
            {alerts.map((a) => (
              <div key={`${a.kind}:${a.location_id || ''}:${a.words}`} style={line}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{a.words}</div>
                  {a.location_id && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{sc.siteName(a.location_id)}</div>}
                </div>
                {sc.canOpen(a.route) && <Btn small kind="soft" onClick={() => follow(a)}>Open</Btn>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={card} data-testid="stock-setup-health">
            <div style={cardTitle}>Set up health</div>
            {rows === null && <EmptyLine>Loading{'…'}</EmptyLine>}
            {rows !== null && !error && !health.checked && <EmptyLine>Not checked yet. Every site is checked each night.</EmptyLine>}
            {rows !== null && !error && health.checked && health.out.length === 0 && <EmptyLine>Every site is in step with the company list.</EmptyLine>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {health.out.map((h) => {
                const f = fixing[h.locationId];
                const words = fixWords(h);
                const failed = f && (f.status === 'failed' || (f.error && !f.jobId));
                const running = f && !f.busy && f.jobId != null && f.status !== 'done' && f.status !== 'failed';
                return (
                  <div key={h.locationId} style={line}>
                    <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{h.words}</div>
                      {h.lines.map((l, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 2 }}>{l}</div>)}
                      {words && <div style={{ fontSize: 12, color: failed ? 'var(--red)' : 'var(--t3)', marginTop: 4 }} role="status">{words}</div>}
                    </div>
                    {canFix && !running && f?.status !== 'done' && (
                      <Btn small kind={failed ? 'soft' : 'primary'} disabled={!!f?.busy} onClick={() => fix(h)}>{failed ? 'Try again' : 'Fix'}</Btn>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {goLive.length > 0 && (
            <div style={card} data-testid="stock-golive-sites">
              <div style={cardTitle}>Go live</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {goLive.map((g) => (
                  <div key={g.locationId} style={line}>
                    <div style={{ flex: '1 1 200px', minWidth: 0, fontSize: 13, color: 'var(--t1)' }}>{g.words}</div>
                    <Btn small kind="soft" onClick={() => open(g.locationId)}>Open</Btn>
                  </div>
                ))}
              </div>
            </div>
          )}

          <CompanySettingsCard orgId={sc.orgId} />
        </div>
      </div>
    </div>
  );
}
