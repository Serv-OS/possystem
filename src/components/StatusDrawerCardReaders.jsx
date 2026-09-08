// src/components/StatusDrawerCardReaders.jsx
// v5.5.58: WiFi-only — Bluetooth pairing UI removed. The network reader is
// assigned in BO; this drawer just shows its status to the cashier.
//
// Pairing consolidation: the drawer is now PROCESSOR-AWARE. Alongside the Stripe
// network-reader block it shows the PAX card terminal this till would actually
// dispatch to — resolved by the SAME findPaxTerminal() the checkout button uses,
// so the drawer and the Card button can never disagree in front of staff. It
// shows liveness (same 2-minute heartbeat rule as Back Office) and whether the
// terminal is connected to Ryft (without which it cannot take a card).

import { useState, useEffect, useCallback } from 'react';
import { getPosDeviceId, resolvePlatformLocationId } from '../lib/networkReader';
import { getActiveLocationSync, platformSupabase } from '../lib/supabase';
import { findPaxTerminal, terminalIsOnline, getPosDeviceId as getPaxPosDeviceId } from '../lib/payments/terminalJobs';

const Sx = {
  pill:    { fontSize: 10, padding: '2px 7px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, border: '1px solid var(--bdr)' },
  rowCard: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg2)', marginBottom: 6 },
  btnXs:   { padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
};

const STATUS_COLOURS = {
  online:  { bg:'var(--grn-d)', fg:'var(--grn)', border:'var(--grn-b)' },
  offline: { bg:'var(--red-d)', fg:'var(--red)', border:'var(--red-b)' },
  unknown: { bg:'var(--bg3)',   fg:'var(--t3)',  border:'var(--bdr)'   },
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
  const posDeviceId = getPosDeviceId();
  const [platformLocationId, setPlatformLocationId] = useState(null);
  const [readers, setReaders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The PAX terminal THIS till dispatches to — same resolver as the Card button.
  const [pax, setPax] = useState(null);           // { terminal, reason } | null

  useEffect(() => {
    (async () => {
      const ops = getActiveLocationSync();
      if (!ops) return;
      const platformId = await resolvePlatformLocationId(ops);
      setPlatformLocationId(platformId);
    })();
  }, []);

  const loadPax = useCallback(async () => {
    try { setPax(await findPaxTerminal({ posDeviceId: getPaxPosDeviceId() })); }
    catch { setPax(null); }   // findPaxTerminal never throws, but stay defensive
  }, []);
  useEffect(() => { loadPax(); }, [loadPax]);

  const loadReaders = useCallback(async () => {
    if (!platformLocationId || !platformSupabase) return;
    setError(null);
    const { data, error: qErr } = await platformSupabase
      .from('payment_devices')
      .select('id, stripe_reader_id, label, device_type, status, last_seen_at, serial_number, ip_address, bound_pos_device_id')
      .eq('location_id', platformLocationId)
      .eq('connection_kind', 'network')
      .order('label', { ascending: true });
    if (qErr) { setError(qErr.message); return; }
    setReaders(data ?? []);
  }, [platformLocationId]);

  useEffect(() => { loadReaders(); }, [loadReaders]);

  const refreshStatus = async () => {
    if (busy || !platformLocationId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-readers-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location_id: platformLocationId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await loadReaders();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const assigned = readers.filter(r => r.bound_pos_device_id === posDeviceId);
  const others = readers.filter(r => r.bound_pos_device_id !== posDeviceId);

  const paxTerminal = pax?.terminal || null;
  const paxOnline = paxTerminal ? terminalIsOnline(paxTerminal) : false;
  const paxRyftLinked = !!paxTerminal?.ryft_terminal_id;
  const paxBoundToThisTill = !!(paxTerminal && paxTerminal.bound_pos_device_id
    && paxTerminal.bound_pos_device_id === getPaxPosDeviceId());

  return (
    <div>
      {/* ── PAX card terminal — what the Card button will actually use ─────── */}
      {(paxTerminal || pax?.reason) && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
            Card terminal
          </div>
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
                  <strong style={{ color: paxRyftLinked ? 'var(--grn)' : 'var(--red)' }}>
                    {paxRyftLinked ? 'Connected to Ryft ✓' : 'Not connected — cannot take card'}
                  </strong>
                </span>
                <span>Last seen: <strong style={{ color:'var(--t2)' }}>{relTime(paxTerminal.last_seen_at)}</strong></span>
              </div>
            </div>
          ) : (
            <div style={{ ...Sx.rowCard, fontSize:12, color:'var(--t3)', lineHeight:1.5 }}>
              {pax.reason}
            </div>
          )}
        </div>
      )}

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          Network reader
        </div>
        <button style={{ ...Sx.btnXs, ...Sx.btnGhost }} disabled={busy} onClick={() => { refreshStatus(); loadPax(); }}>
          {busy ? 'Checking…' : 'Refresh status'}
        </button>
      </div>

      {error && (
        <div style={{ padding:9, background:'var(--red-d)', color:'var(--red)', borderRadius:8, marginBottom:8, fontSize:11, border:'1px solid var(--red-b)', lineHeight:1.4 }}>
          {error}
        </div>
      )}

      {assigned.length === 0 && others.length === 0 && (
        <div style={{ ...Sx.rowCard, fontSize:12, color:'var(--t3)', textAlign:'center', padding:'14px 12px' }}>
          {paxTerminal
            ? <>No Stripe network readers here — this venue takes card on the PAX terminal above.</>
            : <>No card readers registered for this location.<br/>
               <span style={{ fontSize:11, color:'var(--t4)' }}>Admin can add one in Back office → Card readers.</span></>}
        </div>
      )}

      {assigned.map(r => <ReaderRow key={r.id} reader={r} highlight />)}
      {others.length > 0 && (
        <>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', margin:'10px 0 6px' }}>
            Other readers at this location
          </div>
          {others.map(r => <ReaderRow key={r.id} reader={r} />)}
        </>
      )}
    </div>
  );
}

function ReaderRow({ reader, highlight = false }) {
  const status = reader.status || 'unknown';
  const colours = STATUS_COLOURS[status] || STATUS_COLOURS.unknown;
  return (
    <div style={{
      ...Sx.rowCard,
      borderColor: highlight ? 'var(--acc)' : 'var(--bdr)',
      background: highlight ? 'var(--acc-d)' : 'var(--bg2)',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
        <span style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>
          {reader.label || reader.stripe_reader_id || 'Unnamed reader'}
        </span>
        <span style={{ ...Sx.pill, background: colours.bg, color: colours.fg, borderColor: colours.border }}>
          {status}
        </span>
        {highlight && <span style={{ ...Sx.pill, background:'var(--acc)', color:'#0b0c10', borderColor:'var(--acc)' }}>This terminal</span>}
      </div>
      <div style={{ fontSize:11, color:'var(--t3)', display:'flex', flexWrap:'wrap', gap:'2px 12px' }}>
        {reader.device_type && <span>Type: <strong style={{ color:'var(--t2)' }}>{reader.device_type}</strong></span>}
        {reader.serial_number && <span>SN: <strong style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{reader.serial_number}</strong></span>}
        {reader.ip_address && <span>IP: <strong style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{reader.ip_address}</strong></span>}
        <span>Last seen: <strong style={{ color:'var(--t2)' }}>{relTime(reader.last_seen_at)}</strong></span>
      </div>
    </div>
  );
}
