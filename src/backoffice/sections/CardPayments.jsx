// src/backoffice/sections/CardPayments.jsx
//
// "Card payments" — the dedicated ServOS Payments section (v5.6.98), modelled
// on Lightspeed's Financial services page. The Adyen payment reports moved
// here from Reports (Peter, 19 Aug: "all the adyen reports need to be in a
// separate tab called card payments... we don't want to use the word adyen as
// these are ServOS payments").
//
// Tab shape is the FUTURE shape, filled in phases:
//   Overview | Payments | Disputes | Payouts | Documents | Settings
// Payments and Disputes mount the existing self-fetching report components
// (reports/AdyenPayments, reports/AdyenDisputes) unchanged — they carry no
// Reports-shell assumptions. v5.6.99 fills Payouts (reports/AdyenPayouts:
// settlement batches with per-transaction drill-down, fed by
// adyen-report-ingest) and Documents (reports/AdyenStatements: monthly
// printable statement). v5.7.0 (Phase 3) fills Settings: a read-only
// "Processing rates" card served by the adyen-financial `settings` action —
// the venue's agreed rate (per-venue override, else the platform standard,
// set by the platform admin in AdminBillingManager) plus processing/payout
// status chips. Rates are DISPLAY only here: nothing charges from them yet —
// splits/commission collection is Phase 4.
//
// Gated on the venue's processor being 'adyen' (locations.payment_processor
// via the cached getLocationProcessor lookup, same source CardReaders uses).
// Venues on another processor get a short note instead of broken tabs.

import { useEffect, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { getLocationProcessor } from '../../lib/payments/processor';
import AdyenPayments from './reports/AdyenPayments';
import AdyenDisputes from './reports/AdyenDisputes';
import AdyenPayouts from './reports/AdyenPayouts';
import AdyenStatements from './reports/AdyenStatements';

const TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'payments',  label: 'Payments' },
  { id: 'disputes',  label: 'Disputes' },
  { id: 'payouts',   label: 'Payouts' },
  { id: 'documents', label: 'Documents' },
  { id: 'settings',  label: 'Settings' },
];

const S = {
  page: { padding: '32px 40px', maxWidth: 1080 },
  h1:   { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:  { fontSize: 13, color: 'var(--t3)', marginBottom: 20, maxWidth: 720, lineHeight: 1.5 },
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14 },
  cardTitle: { fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 },
  cardBody:  { fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55, margin: 0 },
  tabStrip: { display: 'flex', gap: 4, borderBottom: '1px solid var(--bdr)', marginBottom: 20, flexWrap: 'wrap' },
};

function TabBtn({ active, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '9px 14px', border: 'none', borderBottom: `2px solid ${active ? 'var(--acc)' : 'transparent'}`,
      background: 'transparent', color: active ? 'var(--acc)' : 'var(--t3)',
      fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer', fontFamily: 'inherit',
      marginBottom: -1, transition: 'color .12s',
    }}>
      {label}
    </button>
  );
}

const fmtMinor = (m, cur = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format((Number(m) || 0) / 100);

// ─── Overview: balances / payout-setup card (Phase 4, v5.7.1) ───────────────
// Driven by the adyen-financial `balances` action, which returns one of four
// states. Only `ready` (the venue's own payment account answered with real
// numbers) replaces the honest "coming" card with balance tiles — every other
// state keeps plain words about where setup actually is. Failures never show
// raw errors here; the fallback is always the honest card.
function BalancesCard({ payout, onCompleteSetup, setupBusy, setupErr }) {
  const bal = payout?.state === 'ready' && Array.isArray(payout.balances) && payout.balances.length
    ? payout.balances[0] : null;

  const completeBtn = payout?.can_complete_setup && (
    <div style={{ marginTop: 10 }}>
      <button onClick={onCompleteSetup} disabled={setupBusy} style={{
        padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
        opacity: setupBusy ? 0.6 : 1,
      }}>
        {setupBusy ? 'Opening…' : 'Complete your payout setup'}
      </button>
      <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
        Opens a secure page from our payment partner where you confirm your business details
        and add the bank account your payouts go to. It takes a few minutes.
      </div>
      {setupErr && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{setupErr}</div>}
    </div>
  );

  if (bal) {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>Balances</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {[['Total balance', bal.total_minor], ['Pending', bal.pending_minor]].map(([label, minor]) => (
            <div key={label} style={{ flex: '1 1 180px', maxWidth: 260, border: '1px solid var(--bdr)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg2)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--t1)' }}>{fmtMinor(minor, bal.currency)}</div>
            </div>
          ))}
        </div>
        <p style={{ ...S.cardBody, marginTop: 10 }}>
          {fmtMinor(bal.available_minor, bal.currency)} of this is available now.
          Pending amounts are card payments still settling; they move into your balance automatically.
          {payout.payouts_ok
            ? ' Your balance is paid out to your bank automatically.'
            : ' Payouts to your bank switch on once your payout setup is complete.'}
        </p>
        {!payout.payouts_ok && completeBtn}
      </div>
    );
  }

  if (payout?.state === 'in_progress') {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>Payout setup in progress</div>
        <p style={S.cardBody}>
          Your venue's own payment account is being set up. Once it is finished your live
          balance appears here and payouts go straight to your bank.
          {payout.has_bank ? '' : ' If we are waiting on anything from you, the button below is the quickest way to finish.'}
        </p>
        {completeBtn}
      </div>
    );
  }

  // not_started / awaiting_enablement / unknown → the honest card, unchanged.
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Balances and payouts</div>
      <p style={S.cardBody}>
        Balances and instant payouts are coming. They need per-venue payment accounts,
        in progress with our payment partner. Until then, payouts continue on your
        existing settlement schedule.
      </p>
    </div>
  );
}

function Chip({ on, label }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
      background: on ? 'var(--grn-d, rgba(21,194,106,.1))' : 'var(--bg2)',
      color: on ? 'var(--grn)' : 'var(--t3)',
      border: on ? 'none' : '1px solid var(--bdr)',
      textTransform: 'uppercase', letterSpacing: '.05em',
    }}>
      {label}
    </span>
  );
}

// ─── Settings tab (Phase 3, v5.7.0) ─────────────────────────────────────────
// Venue-facing and READ-ONLY. The rate comes from the adyen-financial
// `settings` action: this venue's agreed rate if one is recorded, else the
// ServOS standard rate. Rates are set by ServOS (the platform admin) as part
// of the venue's agreement — there is deliberately no editing here.
// ⚠ Display + future-billing configuration only in this phase: nothing is
// charged from these rates yet. Splits/commission collection is Phase 4.
function SettingsTab({ status }) {
  const [data, setData] = useState(null);   // null = loading, {error} or settings payload

  useEffect(() => {
    let alive = true;
    (async () => {
      if (isMock) { if (alive) setData({ ok: true, rates: { percent: 1.4, fixed_pence: 5, source: 'platform' }, account: {} }); return; }
      try {
        const locId = await getLocationId().catch(() => null);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || !locId) { if (alive) setData({ error: 'Sign in to view your payment settings.' }); return; }
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-financial`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action: 'settings', ops_location_id: locId }),
        });
        const j = await res.json();
        if (alive) setData(res.ok && j?.ok ? j : { error: j?.error || `HTTP ${res.status}` });
      } catch (e) { if (alive) setData({ error: e.message }); }
    })();
    return () => { alive = false; };
  }, []);

  const active = status?.ok && status?.merchant;
  const rates = data?.rates;
  const hasRate = rates && (rates.percent != null || rates.fixed_pence != null);
  // "1.4% + 5p", trimming trailing zeros on the percent.
  const pctFmt = (v) => String(+Number(v ?? 0).toFixed(2));

  return (
    <>
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={S.cardTitle}>Processing rates</div>
          <Chip on={!!active} label={active ? 'Processing active' : 'Processing enabled'} />
          <Chip on={!!data?.account?.payouts_ok} label={data?.account?.payouts_ok ? 'Payouts enabled' : 'Standard payout schedule'} />
        </div>
        {data == null && <p style={S.cardBody}>Loading your rates…</p>}
        {data?.error && (
          <p style={S.cardBody}>We could not load your rates right now. {data.error}</p>
        )}
        {data?.ok && hasRate && (
          <>
            <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg2)', maxWidth: 420 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
                What you pay per card transaction
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--t1)' }}>
                {pctFmt(rates.percent)}% + {Math.round(Number(rates.fixed_pence ?? 0))}p
              </div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
                One simple all-in rate, per card payment.
              </div>
            </div>
            <p style={{ ...S.cardBody, marginTop: 10 }}>
              Your rates are set in your ServOS Payments agreement. To review them, talk to
              your ServOS account manager.
            </p>
          </>
        )}
        {data?.ok && !hasRate && (
          <p style={S.cardBody}>
            Your processing rates are in your ServOS Payments agreement and have not been
            added to this page yet. Contact ServOS support and we will show them here.
          </p>
        )}
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>Payouts and bank details</div>
        <p style={S.cardBody}>
          Payout schedule, bank details and statement descriptor settings arrive with
          per-venue payment accounts, in progress with our payment partner. Until then,
          payouts continue on your existing settlement schedule. For card terminal
          settings, see Hardware, then Card readers.
        </p>
      </div>
    </>
  );
}

export default function CardPayments() {
  const [processor, setProcessor] = useState(null);   // null = still resolving
  const [tab, setTab] = useState('overview');
  const [status, setStatus] = useState(null);         // adyen-terminal-admin 'status' (best effort)
  const [payout, setPayout] = useState(null);         // adyen-financial 'balances' (best effort)
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupErr, setSetupErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (isMock) { if (alive) setProcessor('adyen'); return; }
      const locId = await getLocationId().catch(() => null);
      const p = await getLocationProcessor(locId).catch(() => 'stripe');
      if (alive) setProcessor(p);
    })();
    return () => { alive = false; };
  }, []);

  // Overview enrichment — the same status probe the Card terminals panel uses.
  // Best effort only: a failure leaves the static copy, never an error screen.
  useEffect(() => {
    if (processor !== 'adyen' || isMock) return;
    let alive = true;
    (async () => {
      try {
        const locId = await getLocationId().catch(() => null);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || !locId) return;
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-terminal-admin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action: 'status', ops_location_id: locId }),
        });
        const j = await res.json();
        if (alive && res.ok && j?.ok) setStatus(j);
      } catch { /* static copy is the fallback */ }
    })();
    return () => { alive = false; };
  }, [processor]);

  // Balances / payout-setup state for the Overview card. Best effort: any
  // failure leaves the honest "coming" card, never an error screen.
  useEffect(() => {
    if (processor !== 'adyen') return;
    if (isMock) {
      setPayout({ ok: true, state: 'ready', payouts_ok: true, balances: [{ currency: 'GBP', total_minor: 123456, pending_minor: 21050, available_minor: 102406 }] });
      return;
    }
    let alive = true;
    (async () => {
      try {
        const locId = await getLocationId().catch(() => null);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || !locId) return;
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-financial`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action: 'balances', ops_location_id: locId }),
        });
        const j = await res.json();
        if (alive && res.ok && j?.ok) setPayout(j);
      } catch { /* honest card is the fallback */ }
    })();
    return () => { alive = false; };
  }, [processor]);

  // "Complete your payout setup" — mints a fresh single-use hosted onboarding
  // link (they expire in 4 minutes, so never reuse a stored one) and opens it.
  // The tab MUST open synchronously, before any await, or popup blockers eat it.
  const completeSetup = async () => {
    if (setupBusy) return;
    setSetupBusy(true); setSetupErr(null);
    const w = window.open('', '_blank');
    try {
      const locId = await getLocationId().catch(() => null);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || !locId) throw new Error('no session');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-financial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'payout_setup_link', ops_location_id: locId, return_url: window.location.origin }),
      });
      const j = await res.json();
      if (res.ok && j?.ok && j.url) {
        if (w) w.location = j.url; else window.open(j.url, '_blank', 'noopener');
      } else {
        if (w) w.close();
        setSetupErr(j?.error || 'We could not open the setup page right now. Try again in a moment.');
      }
    } catch {
      if (w) w.close();
      setSetupErr('We could not open the setup page right now. Try again in a moment.');
    } finally { setSetupBusy(false); }
  };

  if (processor == null) {
    return <div style={S.page}><div style={{ padding: 24, color: 'var(--t3)', fontSize: 13 }}>Loading…</div></div>;
  }

  if (processor !== 'adyen') {
    return (
      <div style={S.page}>
        <h1 style={S.h1}>ServOS Payments</h1>
        <div style={S.sub}>Card payment processing, disputes and payouts in one place.</div>
        <div style={S.card}>
          <div style={S.cardTitle}>ServOS Payments is not enabled for this venue</div>
          <p style={S.cardBody}>
            This venue takes cards through a different payment setup, so ServOS Payments
            reporting is not available here. Talk to ServOS if you would like to move this
            venue onto ServOS Payments.
          </p>
        </div>
      </div>
    );
  }

  const active = status?.ok && status?.merchant;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>ServOS Payments</h1>
      <div style={S.sub}>Card payment processing for this venue: payments, disputes, payouts and documents.</div>

      <div style={S.tabStrip}>
        {TABS.map(t => <TabBtn key={t.id} active={tab === t.id} label={t.label} onClick={() => setTab(t.id)} />)}
      </div>

      {tab === 'overview' && (
        <>
          <div style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{status?.venue || 'This venue'}</div>
              <span style={{
                fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
                background: 'var(--grn-d, rgba(21,194,106,.1))', color: 'var(--grn)',
                textTransform: 'uppercase', letterSpacing: '.05em',
              }}>
                {active ? 'Processing active' : 'Processing enabled'}
              </span>
            </div>
            <p style={{ ...S.cardBody, marginTop: 8 }}>
              Card payments at this venue are processed by ServOS Payments.
              {status?.storeId
                ? ' Card terminals are registered and payments route to this venue automatically.'
                : ''}
              {' '}Every payment, refund and dispute appears in the tabs above as it happens.
            </p>
          </div>
          <BalancesCard payout={payout} onCompleteSetup={completeSetup} setupBusy={setupBusy} setupErr={setupErr} />
        </>
      )}

      {tab === 'payments' && <AdyenPayments />}
      {tab === 'disputes' && <AdyenDisputes />}

      {tab === 'payouts' && <AdyenPayouts />}
      {tab === 'documents' && <AdyenStatements />}
      {tab === 'settings' && <SettingsTab status={status} />}
    </div>
  );
}
