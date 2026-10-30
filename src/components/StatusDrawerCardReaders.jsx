// src/components/StatusDrawerCardReaders.jsx
// The card terminal is assigned in Back Office; this drawer just shows its
// status to the cashier.
//
// It shows the card terminal this till would actually dispatch to — resolved by
// the SAME findPaxTerminal() the checkout button uses, so the drawer and the
// Card button can never disagree in front of staff. It shows liveness (same
// 2-minute heartbeat rule as Back Office) and whether the terminal is linked to
// Adyen (without which it cannot take a card).

import { useState, useEffect, useCallback } from 'react';
import { findPaxTerminal, terminalIsOnline, getPosDeviceId as getPaxPosDeviceId } from '../lib/payments/terminalJobs';
import { terminalProcessor } from '../lib/payments/terminalProcessor.js';

const Sx = {
  pill:    { fontSize: 10, padding: '2px 7px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, border: '1px solid var(--bdr)' },
  rowCard: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg2)', marginBottom: 6 },
  btnXs:   { padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
};

function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export default function StatusDrawerCardReaders() {
  const [busy, setBusy] = useState(false);
  // The terminal THIS till dispatches to — same resolver as the Card button.
  const [pax, setPax] = useState(null);           // { terminal, reason } | null

  const loadPax = useCallback(async () => {
    setBusy(true);
    try { setPax(await findPaxTerminal({ posDeviceId: getPaxPosDeviceId() })); }
    catch { setPax(null); }   // findPaxTerminal never throws, but stay defensive
    finally { setBusy(false); }
  }, []);
  useEffect(() => { loadPax(); }, [loadPax]);

  const paxTerminal = pax?.terminal || null;
  const paxOnline = paxTerminal ? terminalIsOnline(paxTerminal) : false;
  // 'Adyen' when this reader has an Adyen terminal id (terminalProcessor). Null means it cannot take a card.
  const paxProcessor = terminalProcessor(paxTerminal);
  const paxBoundToThisTill = !!(paxTerminal && paxTerminal.bound_pos_device_id
    && paxTerminal.bound_pos_device_id === getPaxPosDeviceId());

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          Card terminal
        </div>
        <button style={{ ...Sx.btnXs, ...Sx.btnGhost }} disabled={busy} onClick={loadPax}>
          {busy ? 'Checking…' : 'Refresh status'}
        </button>
      </div>

      {/* ── Card terminal — what the Card button will actually use ─────── */}
      {paxTerminal ? (
        <div style={{ ...Sx.rowCard, borderColor: paxBoundToThisTill ? 'var(--acc)' : 'var(--bdr)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
            <span style={{
              width:8, height:8, borderRadius:'50%', flexShrink:0,
              background: paxOnline ? 'var(--grn)' : 'var(--t4)',
            }} />
            <span style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>
              {paxTerminal.label || 'Card terminal'}
            </span>
            <span style={{ ...Sx.pill,
              background: paxOnline ? 'var(--grn-d)' : 'var(--bg3)',
              color:      paxOnline ? 'var(--grn)'   : 'var(--t3)',
              borderColor:paxOnline ? 'var(--grn-b)' : 'var(--bdr)' }}>
              {paxOnline ? 'online' : 'offline'}
            </span>
            {paxBoundToThisTill
              ? <span style={{ ...Sx.pill, background:'var(--acc)', color:'#0b0c10', borderColor:'var(--acc)' }}>This till</span>
              : paxTerminal.bound_pos_device_id
                ? <span style={{ ...Sx.pill }}>assigned to another till</span>
                : <span style={{ ...Sx.pill }}>unassigned — only terminal here</span>}
          </div>
          <div style={{ fontSize:11, color:'var(--t3)', display:'flex', flexWrap:'wrap', gap:'2px 12px' }}>
            <span>
              Processor:{' '}
              <strong style={{ color: paxProcessor ? 'var(--grn)' : 'var(--red)' }}>
                {paxProcessor ? `Connected to ${paxProcessor} ✓` : 'Not connected. Cannot take card'}
              </strong>
            </span>
            {/* An Adyen reader does not report in to ServOS, so there is no time to show. */}
            {paxTerminal.last_seen_at && <span>Last seen: <strong style={{ color:'var(--t2)' }}>{relTime(paxTerminal.last_seen_at)}</strong></span>}
          </div>
        </div>
      ) : pax?.reason ? (
        <div style={{ ...Sx.rowCard, fontSize:12, color:'var(--t3)', lineHeight:1.5 }}>
          {pax.reason}
        </div>
      ) : (
        <div style={{ ...Sx.rowCard, fontSize:12, color:'var(--t3)', textAlign:'center', padding:'14px 12px' }}>
          No card readers registered for this location.<br/>
          <span style={{ fontSize:11, color:'var(--t4)' }}>Admin can add one in Back office → Card readers.</span>
        </div>
      )}
    </div>
  );
}
