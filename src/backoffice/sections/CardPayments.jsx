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
// printable statement). Settings stays an honest placeholder until per-venue
// balance accounts exist (adyen-terminal-admin's v5.6.96 store probe is the
// groundwork).
//
// Gated on the venue's processor being 'adyen' (locations.payment_processor
// via the cached getLocationProcessor lookup, same source CardReaders uses).
// Stripe/Ryft venues get a short note instead of broken tabs — their card
// money lives in Reports (Ryft tiles) as before.

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

// One-line placeholder card for the phases still to come.
function ComingSoon({ title, body }) {
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>{title}</div>
      <p style={S.cardBody}>{body}</p>
    </div>
  );
}

export default function CardPayments() {
  const [processor, setProcessor] = useState(null);   // null = still resolving
  const [tab, setTab] = useState('overview');
  const [status, setStatus] = useState(null);         // adyen-terminal-admin 'status' (best effort)

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
            This venue takes cards through a different payment setup, so its card payment
            reports stay under Reports. Talk to ServOS if you would like to move this
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
          <div style={S.card}>
            <div style={S.cardTitle}>Balances and payouts</div>
            <p style={S.cardBody}>
              Balances and instant payouts are coming. They need per-venue payment accounts,
              in progress with our payment partner. Until then, payouts continue on your
              existing settlement schedule.
            </p>
          </div>
        </>
      )}

      {tab === 'payments' && <AdyenPayments />}
      {tab === 'disputes' && <AdyenDisputes />}

      {tab === 'payouts' && <AdyenPayouts />}
      {tab === 'documents' && <AdyenStatements />}
      {tab === 'settings' && (
        <ComingSoon title="Settings" body="Payout schedule, bank details and statement descriptor settings will live here. For card terminal settings, see Hardware, then Card readers." />
      )}
    </div>
  );
}
