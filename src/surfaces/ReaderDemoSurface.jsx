/**
 * ReaderDemoSurface.jsx — ?mode=readerdemo (v5.6.95)
 *
 * A browser-window replica of an Adyen card reader, for sales demos on a laptop.
 *
 * READER-INITIATED FLOWS (v5.6.95) — the two things a real Adyen reader can
 * start from its own screen, now on the idle screen here too:
 *
 *   MANUAL PAYMENT — pure theatre, entirely window-local. Amount keypad
 *   (right-to-left pence entry, exactly like the reader's own keypad) →
 *   Present card → tap → Approved. Books NOTHING and calls NO server — which
 *   faithfully mirrors real Adyen standalone mode, whose payments never create
 *   a POS check either. The approval screen says so.
 *
 *   PAY AT TABLE — the real machinery. The window lists the venue's open
 *   tables with their REMAINING balances (active_sessions.total_minor −
 *   paid_minor, both allow-all-RLS reads), offers Pay all / Split, then calls
 *   adyen-terminal-charge action 'wakeup_table' — a fenced doorway to the SAME
 *   service-role RPC the real reader flow uses
 *   (terminal_start_table_payment_for, migration 20260819c): identical
 *   paid-so-far maths, split legs, priorLegs snapshot, advisory lock and
 *   occupation pinning. For a DEMO- terminal the RPC mints the job in the
 *   pending/simulated shape, so the normal poller below claims it and the
 *   existing tip → present → approve lifecycle carries it; the reconciler then
 *   books the check exactly as it would for a real reader split.
 *
 * THIS IS A REAL SOFTWARE TERMINAL, NOT A MOCK-UP. It follows the exact contract
 * the native paxpay app follows (android/paxpay — JobPoller / PaymentFlow /
 * net/OpsApi; RPCs in supabase/migrations/20260722c_terminal_rpcs.sql):
 *
 *   1. register_terminal_device(DEMO-<serial>) → claim code on screen
 *   2. manager pairs it in Back Office → Card readers → Terminals running the
 *      ServOS app (name it "Demo reader"), binds it to a till
 *   3. terminal_heartbeat every 60s (the green dot in Back Office)
 *   4. polls terminal_jobs for pending jobs addressed to it (RLS
 *      tj_select_terminal: device_uid = auth.uid())
 *   5. terminal_claim_job → tip screen → terminal_commit_tip (the server
 *      computes charge_minor — the ONLY figure this screen displays after the
 *      tip) → terminal_job_sent(DEMO-… txn id) → "Present card" → operator
 *      taps / declines (or auto-tap after ~4s) → terminal_report_result.
 *
 * WHY THE MONEY SETTLES CLEANLY: terminal-job-create marks jobs for a DEMO-…
 * serial as simulated=true, and terminal_report_result keeps the full settle
 * path for simulated jobs (real jobs' device reports are advisory only and
 * would strand in 'charging'). The POS then closes the check exactly as it
 * would for a real reader. The sale is auditable: the transaction id on the
 * job — and on the closed check — is DEMO-… .
 *
 * NON-INTERFERENCE: this is just another terminal_devices row. findPaxTerminal's
 * rules apply unchanged — a terminal bound to a till wins for that till, and
 * several online unbound terminals make the POS refuse. Bind the demo reader to
 * ONE till in Back Office and every other till keeps its real reader.
 *
 * MONEY RULES HONOURED (same as paxpay):
 *   - The tip is committed BEFORE the card. If commit fails, no card screen.
 *   - The displayed charge after the tip is the SERVER's charge_minor, never
 *     client maths.
 *   - Cancel is only offered BEFORE dispatch (terminal_job_sent). After
 *     dispatch the honest outcomes are approved or declined — a cancel claimed
 *     after dispatch is coerced to 'unknown' server-side and parks for a human,
 *     which a demo must never do.
 *
 * ONE BROWSER = ONE SUPABASE SESSION ('rpos-auth'). The pairing is keyed on
 * auth.uid(), so if the browser's session changes (e.g. you sign into Back
 * Office in this browser AFTER pairing the demo under an anonymous session)
 * the reader re-registers and shows a fresh pairing code. Both anonymous and
 * signed-in Back Office sessions work — every RPC on this path is granted to
 * both. Steadiest setup: keep the demo in its own browser profile, or open it
 * in the same browser AFTER signing into Back Office.
 *
 * Static imports only. Every failure renders ON the fake reader screen.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { supabase, ensureAuthToken, isMock } from '../lib/supabase';
import { VERSION } from '../lib/version';

// ── constants ────────────────────────────────────────────────────────────────

const LOGO_URL = 'https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/receipt-assets/branding/servos-logo-primary-dark.png';
const INK = '#0F1211';
const SIGNAL = '#15C26A';
const DECLINE_RED = '#D64545';

const SERIAL_KEY = 'rpos-readerdemo-serial';
const AUTOTAP_KEY = 'rpos-readerdemo-autotap';
const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const PAIR_POLL_MS = 6000;    // re-register while unpaired (keeps the claim TTL alive)
const JOB_POLL_MS = 2500;     // pending-job poll (paxpay: 2s fast / 6s idle)
const HEARTBEAT_MS = 60000;   // terminal_heartbeat
const OWNROW_POLL_MS = 10000; // footer: bound-till state
const JOBWATCH_MS = 2000;     // watch own live job for a POS-side cancel
const AUTO_TAP_MS = 4200;     // auto-tap if the operator does nothing
const RESULT_HOLD_MS = 4500;  // how long approved/declined stays up

const PROP_W = 380;           // bezel width — the whole prop column keys off it
const HOLD_KINDS = ['hold_start', 'hold_capture', 'hold_release', 'hold_increase'];

/** Stable synthetic serial — mirrors paxpay Prefs.serial(): minted once, cached. */
function demoSerial() {
  try {
    const existing = localStorage.getItem(SERIAL_KEY);
    if (existing) return existing;
  } catch { /* storage unavailable — fall through to a per-load serial */ }
  let rand = '';
  try {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    rand = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  } catch {
    rand = Math.random().toString(16).slice(2, 12).toUpperCase();
  }
  const serial = `DEMO-${rand}`;
  try { localStorage.setItem(SERIAL_KEY, serial); } catch { /* quota */ }
  return serial;
}

function fmtMinor(minor, currency) {
  const n = (Number(minor) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}

/** Bands in the three spellings that have ever been written (see terminal-job-create). */
function tipBands(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  for (const k of ['percentBands', 'tip_percentages', 'percentages']) {
    if (Array.isArray(cfg[k])) {
      return cfg[k].map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 100).slice(0, 5);
    }
  }
  return [];
}
function tipEnabled(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const e = cfg.enabled ?? cfg.tipping_enabled;
  return e === true && tipBands(cfg).length > 0;
}
function tipAllowCustom(cfg) {
  const v = cfg?.allowCustom ?? cfg?.allow_custom;
  return v !== false;
}

function mintTxnId() {
  return `DEMO-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
function mintAuthCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Right-to-left pence entry, like the reader's own keypad: 3,6,5,9 → 0.03 →
 *  0.36 → 3.65 → 36.59. Shared by the custom tip, manual payment and split pads. */
function padKey(prev, k) {
  if (k === 'back') return prev.slice(0, -1);
  if (prev.length >= 6) return prev;         // £9,999.99 is plenty for a demo
  if (prev === '' && k === '0') return prev; // 0 first = still £0.00
  return prev + k;
}

/** The contactless ripple + wave glyph shared by every Present-card screen. */
function ContactlessGlyph() {
  return (
    <div className="rdemo-contactless" style={{ marginTop: 26 }}>
      <span /><span /><span />
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6.5 8.5a7 7 0 0 1 0 7M9.5 6.5a10 10 0 0 1 0 11M3.6 10.6a4 4 0 0 1 0 2.8" stroke={INK} strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="17" cy="12" r="1.6" fill={INK} />
      </svg>
    </div>
  );
}

/** Amount keypad screen — manual payment and the split amount use this one component. */
function AmountPad({ title, hint, pence, currency, onKey, onOk, onBack }) {
  const minor = Number(pence || 0);
  return (
    <div style={{ ...sx.fill('#fff'), padding: '24px 20px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: '#667', letterSpacing: 0.4, textTransform: 'uppercase' }}>{title}</div>
        <div style={sx.bigAmount}>{fmtMinor(minor, currency)}</div>
        {hint && <div style={{ ...sx.sub, marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 14, flex: 1 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'].map(k => (
          <button
            key={k}
            style={{ ...sx.keypadBtn, ...(k === 'ok' ? { background: SIGNAL, color: '#fff', border: 'none', opacity: minor > 0 ? 1 : 0.45 } : {}) }}
            disabled={k === 'ok' && minor <= 0}
            onClick={() => { if (k === 'ok') onOk(minor); else onKey(k); }}
          >
            {k === 'back' ? '⌫' : k === 'ok' ? 'OK' : k}
          </button>
        ))}
      </div>
      <button style={{ ...sx.tipBtn, marginTop: 10 }} onClick={onBack}>Back</button>
    </div>
  );
}

// ── the surface ──────────────────────────────────────────────────────────────

export default function ReaderDemoSurface() {
  // phase: boot | pairing | idle | tip | custom | busy | present | result | fatal
  //        | manual_amount | manual_present            (window-local theatre)
  //        | tables | paychoice | split                (reader-initiated Pay at table)
  const [phase, setPhase] = useState('boot');
  const [pairing, setPairing] = useState(null);   // { deviceId, claimCode, status, locationId, label }
  const [job, setJob] = useState(null);           // { id, dueMinor, tipBasisMinor, currency, tipConfig, chargeMinor, txnId, draft }
  const [result, setResult] = useState(null);     // { kind: 'approved'|'declined'|'cancelled', amountMinor, currency, reason, note }
  const [err, setErr] = useState('');             // transient, rendered on the reader screen
  const [busyMsg, setBusyMsg] = useState('');
  const [ownRow, setOwnRow] = useState(null);     // { label, bound_pos_device_id }
  const [online, setOnline] = useState(false);
  const [customPence, setCustomPence] = useState('');
  const [manualPence, setManualPence] = useState('');       // manual payment keypad entry
  const [manualAmountMinor, setManualAmountMinor] = useState(0); // frozen at OK for the present/approve screens
  const [payTables, setPayTables] = useState(null);         // null = load failed, [] = none, [rows]
  const [paySel, setPaySel] = useState(null);               // { tableId, label, billMinor, paidMinor, remainingMinor, sessionId, seatedAt }
  const [splitPence, setSplitPence] = useState('');
  const [autoTap, setAutoTap] = useState(() => {
    try { return localStorage.getItem(AUTOTAP_KEY) !== 'off'; } catch { return true; }
  });

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const jobRef = useRef(null);
  jobRef.current = job;
  const settlingRef = useRef(false);
  const serialRef = useRef(demoSerial());

  const setAutoTapPersist = (on) => {
    setAutoTap(on);
    try { localStorage.setItem(AUTOTAP_KEY, on ? 'on' : 'off'); } catch { /* quota */ }
  };

  // ── boot / (re)register ────────────────────────────────────────────────────
  const registerNow = useCallback(async () => {
    if (isMock || !supabase) {
      setErr('This build has no Supabase connection (mock mode). The demo reader needs the live app URL.');
      setPhase('fatal');
      return null;
    }
    try {
      await ensureAuthToken();
      const { data, error } = await supabase.rpc('register_terminal_device', {
        p_serial: serialRef.current,
        p_app_version: `readerdemo web ${VERSION}`,
      });
      if (error) { setErr(`Registration failed: ${error.message}`); setOnline(false); return null; }
      setOnline(true);
      const p = {
        deviceId: data?.device_id ?? null,
        claimCode: data?.claim_code ?? null,
        status: data?.status ?? 'unpaired',
        locationId: data?.location_id ?? null,
        label: data?.label ?? null,
      };
      setPairing(p);
      return p;
    } catch (e) {
      setErr(`Could not reach the server: ${e?.message || e}`);
      setOnline(false);
      return null;
    }
  }, []);

  useEffect(() => {
    let stop = false;
    (async () => {
      const p = await registerNow();
      if (stop) return;
      if (!p) { setPhase(ph => (ph === 'fatal' ? 'fatal' : 'pairing')); return; }
      setPhase(p.status === 'paired' && p.deviceId ? 'idle' : 'pairing');
    })();
    return () => { stop = true; };
  }, [registerNow]);

  // ── while unpaired: re-register every 6s (this is also how we LEARN we were
  //    claimed — same as paxpay's heartbeat/re-register loop) ─────────────────
  useEffect(() => {
    if (phase !== 'pairing') return undefined;
    const t = setInterval(async () => {
      const p = await registerNow();
      if (p?.status === 'paired' && p.deviceId) {
        setErr('');
        setPhase('idle');
      }
    }, PAIR_POLL_MS);
    return () => clearInterval(t);
  }, [phase, registerNow]);

  // ── heartbeat, once paired ─────────────────────────────────────────────────
  useEffect(() => {
    const deviceId = pairing?.deviceId;
    if (!deviceId || pairing?.status !== 'paired' || !supabase) return undefined;
    const beat = async () => {
      const { error } = await supabase.rpc('terminal_heartbeat', {
        p_device_id: deviceId,
        p_app_version: `readerdemo web ${VERSION}`,
      });
      if (error) console.warn('[readerdemo] heartbeat failed:', error.message);
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [pairing?.deviceId, pairing?.status]);

  // ── footer: own terminal row (bound-till state). RLS td_select lets a device
  //    read the row it owns — same read localTerminalIdentity.js relies on. ───
  useEffect(() => {
    const deviceId = pairing?.deviceId;
    if (!deviceId || pairing?.status !== 'paired' || !supabase) return undefined;
    const read = async () => {
      const { data, error } = await supabase
        .from('terminal_devices')
        .select('label, bound_pos_device_id, status, active')
        .eq('id', deviceId)
        .maybeSingle();
      if (error) return;
      if (data) { setOwnRow(data); return; }
      // No row visible = RLS says this session no longer owns the pairing (the
      // browser's ONE auth session changed under us, e.g. a Back Office sign-in
      // after pairing anonymously). Silent deafness is the worst demo failure —
      // re-register so a fresh pairing code appears instead.
      if (phaseRef.current === 'idle') {
        setErr('Pairing lost (the browser session changed). Getting a new pairing code…');
        setPhase('pairing');
        registerNow();
      }
    };
    read();
    const t = setInterval(read, OWNROW_POLL_MS);
    return () => clearInterval(t);
  }, [pairing?.deviceId, pairing?.status, registerNow]);

  // ── recover from a lost pairing (session changed / row retired) ────────────
  const handleRpcError = useCallback((error, what) => {
    const msg = error?.message || String(error);
    if (/not paired|no session|has no location/i.test(msg)) {
      // The browser's auth session changed since we paired (one browser = one
      // session) or the row was retired. Re-register — a fresh claim code
      // appears and the manager pairs again.
      setErr('Pairing lost (the browser session changed or the reader was retired). Getting a new pairing code…');
      setJob(null);
      setPhase('pairing');
      registerNow();
      return true;
    }
    setErr(`${what}: ${msg}`);
    return false;
  }, [registerNow]);

  // ── idle: poll for a pending job addressed to THIS terminal ────────────────
  useEffect(() => {
    const deviceId = pairing?.deviceId;
    if (phase !== 'idle' || !deviceId || !supabase) return undefined;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || phaseRef.current !== 'idle') return;
      inFlight = true;
      try {
        // Same filtered SELECT paxpay uses (OpsApi.pollPendingJob) — RLS
        // tj_select_terminal fences it to jobs addressed to this terminal.
        const { data, error } = await supabase
          .from('terminal_jobs')
          .select('id, check_key, tip_basis_minor, due_minor, currency, tip_config, check_draft, status, created_at')
          .eq('target_terminal_id', deviceId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(1);
        if (error) {
          setOnline(false);
          console.warn('[readerdemo] job poll failed:', error.message);
          setErr(`Job poll failed: ${error.message}`);
          return;
        }
        setOnline(true);
        const row = data?.[0];
        if (!row) { setErr(e => (e && e.startsWith('Job poll') ? '' : e)); return; }

        // Claim it — atomic CAS server-side; a lost race is a normal outcome.
        const { data: claim, error: claimErr } = await supabase.rpc('terminal_claim_job', { p_job_id: row.id });
        if (claimErr) { handleRpcError(claimErr, 'Could not claim the payment'); return; }
        if (!claim?.ok) {
          const reason = claim?.reason || 'claim rejected. Already taken, or no longer pending';
          setErr(`A payment was waiting but could not be claimed: ${reason}`);
          return;
        }
        setErr('');
        const d = row.check_draft || {};
        const j = {
          id: row.id,
          dueMinor: Number(row.due_minor) || 0,
          tipBasisMinor: Number(row.tip_basis_minor) || 0,
          currency: row.currency || 'GBP',
          tipConfig: row.tip_config || null,
          chargeMinor: null,
          txnId: null,
          // v5.6.95 — enough of the draft to narrate a split on the approval
          // screen. Display only; the server owns every figure that matters.
          draft: {
            source: d.source || null,
            partial: d.partial === true,
            remainingAfterMinor: Number(d.remainingAfterMinor),
            tableLabel: d.tableLabel || d.tableId || null,
          },
        };
        setJob(j);
        jobRef.current = j;
        if (tipEnabled(row.tip_config)) {
          phaseRef.current = 'tip';   // stop the poll re-firing before the re-render lands
          setPhase('tip');
        } else {
          phaseRef.current = 'busy';
          commitAndDispatch(j, 0);
        }
      } finally {
        inFlight = false;
      }
    };
    poll();
    const t = setInterval(poll, JOB_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pairing?.deviceId, handleRpcError]);

  // ── while the tip screen is up: watch the row for a POS-side cancel ────────
  useEffect(() => {
    if ((phase !== 'tip' && phase !== 'custom') || !job?.id || !supabase) return undefined;
    const t = setInterval(async () => {
      const { data, error } = await supabase
        .from('terminal_jobs')
        .select('status')
        .eq('id', job.id)
        .maybeSingle();
      if (error || !data) return;
      if (data.status === 'cancelled' || data.status === 'expired') {
        setResult({ kind: 'cancelled', amountMinor: null, currency: job.currency, reason: 'Cancelled from the till' });
        setJob(null);
        setPhase('result');
      }
    }, JOBWATCH_MS);
    return () => clearInterval(t);
  }, [phase, job?.id, job?.currency]);

  // ── tip → commit → dispatch. THE ORDERING RULE: tip is committed BEFORE any
  //    card screen, and the charge shown afterwards is the SERVER's figure. ───
  async function commitAndDispatch(j, tipMinor) {
    setBusyMsg('Recording the tip…');
    setPhase('busy');
    try {
      const { data: commit, error: commitErr } = await supabase.rpc('terminal_commit_tip', {
        p_job_id: j.id,
        p_tip_minor: tipMinor,
      });
      if (commitErr) {
        // DO NOT CHARGE if the commit failed — same rule as paxpay commitTip().
        if (!handleRpcError(commitErr, 'The tip could not be recorded')) setPhase('tip');
        return;
      }
      const chargeMinor = Number(commit?.charge_minor);
      if (!Number.isFinite(chargeMinor) || chargeMinor <= 0) {
        setErr('The server returned no charge amount. Cannot continue.');
        setPhase('tip');
        return;
      }

      // The point of no return: charging_unsent → charging. Skipping this would
      // let the sweeper record a dispatched demo charge as a clean cancellation.
      const txnId = mintTxnId();
      setBusyMsg('Connecting…');
      const { data: sent, error: sentErr } = await supabase.rpc('terminal_job_sent', {
        p_job_id: j.id,
        p_transaction_id: txnId,
      });
      if (sentErr) { handleRpcError(sentErr, 'Could not dispatch the payment'); setPhase('idle'); setJob(null); return; }
      if (!sent?.ok) { setErr('The payment could not be dispatched (job no longer ready).'); setPhase('idle'); setJob(null); return; }

      const next = { ...j, chargeMinor, txnId };
      setJob(next);
      jobRef.current = next;
      setBusyMsg('');
      setPhase('present');
    } catch (e) {
      setErr(`Payment step failed: ${e?.message || e}`);
      setPhase('idle');
      setJob(null);
    }
  }

  // ── settle (approved / declined). reported_minor = the server's own charge,
  //    so the amount cross-check can never park a demo job needs_human. ───────
  const settle = useCallback(async (kind) => {
    const j = jobRef.current;
    if (!j?.id || settlingRef.current) return;
    settlingRef.current = true;
    try {
      const params = kind === 'approved'
        ? {
            p_job_id: j.id,
            p_status: 'approved',
            p_transaction_id: j.txnId,
            p_auth_code: mintAuthCode(),
            p_card: { brand: 'visa', last4: '4242', entry_mode: 'contactless' },
            p_reported_minor: j.chargeMinor,
            p_decline_reason: null,
          }
        : {
            p_job_id: j.id,
            p_status: 'declined',
            p_transaction_id: j.txnId,
            p_auth_code: null,
            p_card: { brand: 'visa', last4: '4242', entry_mode: 'contactless' },
            p_reported_minor: null,
            p_decline_reason: 'card_declined (demo)',
          };
      const { data, error } = await supabase.rpc('terminal_report_result', params);
      if (error) { handleRpcError(error, 'Could not report the result'); return; }
      if (!data?.ok) { setErr('The result was not accepted by the server.'); return; }
      // v5.6.95 — narrate a Pay-at-table split: a partial leg leaves the table
      // open with the remainder still owed; the final leg closes the whole
      // occupation via the POS reconciler.
      let note = null;
      const dr = j.draft;
      if (kind === 'approved' && dr?.source === 'adyen_pay_at_table') {
        note = (dr.partial && Number.isFinite(dr.remainingAfterMinor) && dr.remainingAfterMinor > 0)
          ? `${fmtMinor(dr.remainingAfterMinor, j.currency)} left on ${dr.tableLabel || 'the table'} — table stays open`
          : `${dr.tableLabel || 'Table'} paid in full — the till books the sale and clears the table`;
      }
      setResult({ kind, amountMinor: j.chargeMinor, currency: j.currency, reason: null, note });
      setJob(null);
      setPhase('result');
    } catch (e) {
      setErr(`Could not report the result: ${e?.message || e}`);
    } finally {
      settlingRef.current = false;
    }
  }, [handleRpcError]);

  // ── cancel — ONLY before dispatch (claimed/tipping). A cancel after dispatch
  //    is coerced to 'unknown' server-side and parks for a human. ─────────────
  const cancelPreDispatch = useCallback(async () => {
    const j = jobRef.current;
    if (!j?.id) return;
    try {
      const { error } = await supabase.rpc('terminal_report_result', {
        p_job_id: j.id,
        p_status: 'cancelled',
        p_transaction_id: null,
        p_auth_code: null,
        p_card: null,
        p_reported_minor: null,
        p_decline_reason: null,
      });
      if (error) { handleRpcError(error, 'Could not cancel'); return; }
      setResult({ kind: 'cancelled', amountMinor: null, currency: j.currency, reason: 'Cancelled on the reader' });
      setJob(null);
      setPhase('result');
    } catch (e) {
      setErr(`Could not cancel: ${e?.message || e}`);
    }
  }, [handleRpcError]);

  // ── manual payment (v5.6.95) — pure theatre, entirely window-local ─────────
  // No job row, no RPC, no booking: a real Adyen reader's standalone mode also
  // never creates a POS check. The approval screen says exactly that.
  const settleManual = useCallback((kind) => {
    setResult({
      kind,
      amountMinor: manualAmountMinor,
      currency: 'GBP',
      reason: kind === 'declined' ? 'card_declined (demo)' : null,
      note: kind === 'approved'
        ? 'Standalone demo — not recorded in the POS (same as a real reader\'s manual payment)'
        : null,
    });
    setPhase('result');
  }, [manualAmountMinor]);

  // ── Pay at table (v5.6.95): table list with remaining balances ─────────────
  // Direct reads with the shared client: active_sessions has an allow-all
  // policy and floor_tables an anon read policy (000_baseline_ops.sql — the
  // 20260429 tenant-RLS migration was never applied). Failures render ON the
  // reader screen with a retry — never a silent bounce to idle.
  const loadTables = useCallback(async () => {
    const locId = pairing?.locationId;
    if (!locId) {
      setErr('This reader has no venue yet — pair it in Back Office first.');
      return;
    }
    setBusyMsg('Loading tables…');
    setPhase('busy');
    try {
      await ensureAuthToken();
      const [sessRes, tabRes] = await Promise.all([
        supabase.from('active_sessions')
          .select('table_id, total_minor, paid_minor, session')
          .eq('location_id', locId),
        // floor_tables.location_id is TEXT (active_sessions' is uuid) — compare as text.
        supabase.from('floor_tables')
          .select('id, label')
          .eq('location_id', String(locId)),
      ]);
      if (sessRes.error) {
        setErr(`Could not load the open tables: ${sessRes.error.message}`);
        setPayTables(null);              // tables screen shows a Try again button
        setPhase('tables');
        return;
      }
      // Labels are cosmetic — a failed floor_tables read falls back to table ids.
      if (tabRes.error) console.warn('[readerdemo] floor_tables read failed:', tabRes.error.message);
      const labels = new Map((tabRes.data || []).map(r => [r.id, r.label]));
      const rows = (sessRes.data || [])
        .filter(r => Number(r.total_minor) > 0)
        .map(r => {
          const bill = Number(r.total_minor) || 0;
          const paid = Number(r.paid_minor) || 0;
          return {
            tableId: r.table_id,
            label: labels.get(r.table_id) || r.table_id,
            billMinor: bill,
            paidMinor: paid,
            remainingMinor: bill - paid,
            // Occupation pin for the RPC: charge THIS party, refuse a re-seat.
            sessionId: r.session?.id != null ? String(r.session.id) : null,
            seatedAt: r.session?.seatedAt != null ? String(r.session.seatedAt) : null,
          };
        })
        .filter(r => r.remainingMinor > 0)
        .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' }));
      setPayTables(rows);
      setBusyMsg('');
      setPhase('tables');
    } catch (e) {
      setErr(`Could not load the open tables: ${e?.message || e}`);
      setPayTables(null);
      setPhase('tables');
    }
  }, [pairing?.locationId]);

  // ── Pay at table: wake this reader up on a table (Pay all → amountMinor null,
  //    Split → the entered amount, clamped to remaining here AND server-side).
  //    The edge fn's fence: this window's own auth.uid() must own the DEMO-
  //    terminal row. On success the RPC mints a pending job addressed to this
  //    reader and the normal idle poller claims it (≤2.5s) → tip → present. ───
  async function wakeupTable(sel, amountMinor) {
    setBusyMsg('Starting the payment…');
    setPhase('busy');
    try {
      const token = await ensureAuthToken();
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/adyen-terminal-charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'wakeup_table',
          terminal_device_id: pairing?.deviceId,
          table_id: sel.tableId,
          amount_minor: amountMinor ?? null,
          session_id: sel.sessionId,
          seated_at: sel.seatedAt,
        }),
      });
      let j = {};
      try { j = await res.json(); } catch { /* empty body */ }
      if (!res.ok || j?.ok !== true) {
        // The RPC's messages are operator-quality ("this table has already been
        // paid…") — show them verbatim on the bezel and stay on the choice screen.
        setErr(`Could not start the payment: ${j?.error || `server said ${res.status}`}`);
        setPhase('paychoice');
        return;
      }
      setBusyMsg('');
      setPhase('idle');   // the job poller claims the freshly minted pending job
    } catch (e) {
      setErr(`Could not start the payment: ${e?.message || e}`);
      setPhase('paychoice');
    }
  }

  // ── auto-tap ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if ((phase !== 'present' && phase !== 'manual_present') || !autoTap) return undefined;
    const t = setTimeout(() => {
      if (phaseRef.current === 'manual_present') settleManual('approved');
      else settle('approved');
    }, AUTO_TAP_MS);
    return () => clearTimeout(t);
  }, [phase, autoTap, settle, settleManual]);

  // ── result screen → back to idle ───────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'result') return undefined;
    const t = setTimeout(() => { setResult(null); setPhase('idle'); }, RESULT_HOLD_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // ── bar-tab hold animation (v5.6.94) ──────────────────────────────────────
  // Tab pre-auth holds have NO terminal_jobs row for this window to poll — the
  // server simulates them directly (adyen-terminal-charge's DEMO-HOLD branch).
  // The POS broadcasts each hold action on a same-origin channel purely so
  // this window can mime it: card-present ripple, then a tick. No acks, no
  // timing dependency — the server branch succeeds whether or not this window
  // exists, so everything here is cosmetic. Only plays over the idle screen; a
  // real job in progress always keeps the screen.
  const [holdAnim, setHoldAnim] = useState(null); // { kind, amountMinor, stage: 'present' | 'tick' }
  useEffect(() => {
    let ch;
    try { ch = new BroadcastChannel('rpos-demo-reader'); } catch { return undefined; }
    const timers = [];
    ch.onmessage = (ev) => {
      const kind = ev?.data?.kind;
      if (!HOLD_KINDS.includes(kind)) return;
      if (phaseRef.current !== 'idle') return;
      timers.splice(0).forEach(clearTimeout);
      const n = Number(ev.data.amountMinor);
      const amountMinor = Number.isFinite(n) && n > 0 ? n : null;
      if (kind === 'hold_release') {
        // Nothing to present — releasing a hold never touches the card.
        setHoldAnim({ kind, amountMinor, stage: 'tick' });
        timers.push(setTimeout(() => setHoldAnim(null), 2600));
        return;
      }
      setHoldAnim({ kind, amountMinor, stage: 'present' });
      timers.push(setTimeout(() => setHoldAnim(a => (a ? { ...a, stage: 'tick' } : a)), 1900));
      timers.push(setTimeout(() => setHoldAnim(null), 4500));
    };
    return () => { timers.forEach(clearTimeout); ch.close(); };
  }, []);

  // ── fit-to-viewport scaling (v5.6.94) ─────────────────────────────────────
  // The whole prop — bezel + operator strip + status lines — must be visible
  // with NO scrolling: on laptop screens the strip fell below the fold and the
  // owner reported "there are no buttons". The bezel keeps its fixed design
  // size (crisp at scale 1 on tall screens); the finished column is measured
  // and transform-scaled down to fit, and the wrapper takes the SCALED size so
  // centring stays true (transforms do not change layout size).
  const propRef = useRef(null);
  const [fit, setFit] = useState({ scale: 1, w: PROP_W, h: 900 });
  useLayoutEffect(() => {
    const el = propRef.current;
    if (!el) return undefined;
    const recompute = () => {
      const natW = el.offsetWidth || PROP_W;
      const natH = el.offsetHeight || 900;
      const s = Math.min(1, (window.innerHeight - 24) / natH, (window.innerWidth - 24) / natW);
      setFit(f => (f.scale === s && f.w === natW && f.h === natH ? f : { scale: s, w: natW, h: natH }));
    };
    recompute();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(recompute) : null;
    ro?.observe(el);
    window.addEventListener('resize', recompute);
    return () => { ro?.disconnect(); window.removeEventListener('resize', recompute); };
  }, []);

  // ── custom tip keypad (entry rule shared with AmountPad via padKey) ────────
  const customKey = (k) => setCustomPence(prev => padKey(prev, k));
  const customMinor = Number(customPence || 0);

  // ── render helpers ─────────────────────────────────────────────────────────

  const bands = tipBands(job?.tipConfig);
  const isPaired = pairing?.status === 'paired' && !!pairing?.deviceId;
  const bound = !!ownRow?.bound_pos_device_id;

  const screen = (() => {
    if (phase === 'fatal') {
      return (
        <div style={sx.center('#fff')}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <div style={sx.h2}>Demo reader unavailable</div>
          <div style={sx.sub}>{err || 'This build cannot reach the server.'}</div>
        </div>
      );
    }
    if (phase === 'boot') {
      return (
        <div style={sx.center(SIGNAL)}>
          <img src={LOGO_URL} alt="ServOS" style={sx.logo} />
          <div style={{ ...sx.sub, color: 'rgba(255,255,255,.85)' }}>Starting…</div>
        </div>
      );
    }
    if (phase === 'pairing') {
      return (
        <div style={sx.center('#fff')}>
          <div style={{ ...sx.h2, marginTop: 0 }}>Pair this demo reader</div>
          <div style={sx.claimCode}>{pairing?.claimCode || '·····'}</div>
          <div style={{ ...sx.sub, maxWidth: 260 }}>
            In Back Office go to <b>Card readers → Terminals running the ServOS app</b>,
            enter this code and name it <b>Demo reader</b>. Then bind it to a till.
          </div>
          <div style={sx.pulseDotRow}><span className="rdemo-dot" /> Waiting to be claimed…</div>
        </div>
      );
    }
    // Bar-tab hold mime (v5.6.94) — cosmetic overlay while otherwise idle.
    if (phase === 'idle' && holdAnim) {
      if (holdAnim.stage === 'present') {
        const heading = holdAnim.kind === 'hold_increase' ? 'Increase hold'
          : holdAnim.kind === 'hold_capture' ? 'Charge held card' : 'Card hold';
        return (
          <div style={sx.center('#fff')}>
            <div style={{ fontSize: 13, color: '#667', letterSpacing: 0.4, textTransform: 'uppercase' }}>{heading}</div>
            {holdAnim.amountMinor != null && <div style={sx.bigAmount}>{fmtMinor(holdAnim.amountMinor, 'GBP')}</div>}
            <ContactlessGlyph />
            <div style={{ ...sx.h2, fontSize: 19 }}>Present card</div>
            <div style={sx.sub}>Demo hold. No real card is charged.</div>
          </div>
        );
      }
      const label = { hold_start: 'Hold placed', hold_capture: 'Tab charged', hold_increase: 'Hold increased', hold_release: 'Hold released' }[holdAnim.kind];
      const bg = holdAnim.kind === 'hold_release' ? '#3a3f3d' : SIGNAL;
      return (
        <div style={sx.center(bg)}>
          <div style={sx.resultIcon}>
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none"><path d="M4.5 12.5l5 5 10-11" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div style={{ ...sx.h2, color: '#fff', fontSize: 24 }}>{label}</div>
          {holdAnim.amountMinor != null && holdAnim.kind !== 'hold_release' && (
            <div style={{ ...sx.bigAmount, color: '#fff', fontSize: 34 }}>{fmtMinor(holdAnim.amountMinor, 'GBP')}</div>
          )}
          <div style={{ ...sx.sub, color: 'rgba(255,255,255,.85)' }}>Demo hold, marked DEMO-HOLD</div>
        </div>
      );
    }
    if (phase === 'idle') {
      return (
        <div style={sx.center(SIGNAL)}>
          <img src={LOGO_URL} alt="ServOS" style={sx.logo} />
          {/* v5.6.95 — the reader-initiated flows a real Adyen reader offers
              from its own screen. Only useful once paired. */}
          {isPaired && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24, width: '78%' }}>
              <button style={sx.idleBtn} onClick={loadTables}>Pay at table</button>
              <button style={sx.idleBtn} onClick={() => { setManualPence(''); setErr(''); setPhase('manual_amount'); }}>
                Manual payment
              </button>
            </div>
          )}
          <div style={{ position: 'absolute', bottom: 26, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,.8)', fontSize: 13 }}>
            <span className="rdemo-dot" style={{ background: '#fff' }} /> Ready
          </div>
        </div>
      );
    }
    if (phase === 'busy') {
      return (
        <div style={sx.center('#fff')}>
          <div className="rdemo-spinner" />
          <div style={sx.sub}>{busyMsg || 'One moment…'}</div>
        </div>
      );
    }
    if (phase === 'tip' && job) {
      return (
        <div style={{ ...sx.fill('#fff'), padding: '26px 20px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#667', letterSpacing: 0.4, textTransform: 'uppercase' }}>Total</div>
            <div style={sx.bigAmount}>{fmtMinor(job.dueMinor, job.currency)}</div>
            <div style={{ ...sx.h2, fontSize: 19, marginTop: 14 }}>Add a tip?</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: bands.length > 3 ? '1fr 1fr' : '1fr', gap: 10, marginTop: 16 }}>
            {bands.map(pct => {
              const tip = Math.round(job.tipBasisMinor * pct / 100);
              return (
                <button key={pct} style={sx.tipBtn} onClick={() => commitAndDispatch(job, tip)}>
                  <span style={{ fontWeight: 700 }}>{pct}%</span>
                  <span style={{ color: '#667', fontSize: 13 }}>{fmtMinor(tip, job.currency)}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            {tipAllowCustom(job.tipConfig) && (
              <button style={{ ...sx.tipBtn, flex: 1 }} onClick={() => { setCustomPence(''); setPhase('custom'); }}>
                Custom
              </button>
            )}
            <button style={{ ...sx.tipBtn, flex: 1 }} onClick={() => commitAndDispatch(job, 0)}>
              No tip
            </button>
          </div>
        </div>
      );
    }
    if (phase === 'custom' && job) {
      return (
        <div style={{ ...sx.fill('#fff'), padding: '24px 20px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#667' }}>Custom tip</div>
            <div style={sx.bigAmount}>{fmtMinor(customMinor, job.currency)}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 14, flex: 1 }}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'].map(k => (
              <button
                key={k}
                style={{ ...sx.keypadBtn, ...(k === 'ok' ? { background: SIGNAL, color: '#fff', border: 'none' } : {}) }}
                onClick={() => {
                  if (k === 'ok') commitAndDispatch(job, customMinor);
                  else customKey(k);
                }}
              >
                {k === 'back' ? '⌫' : k === 'ok' ? 'OK' : k}
              </button>
            ))}
          </div>
          <button style={{ ...sx.tipBtn, marginTop: 10 }} onClick={() => setPhase('tip')}>Back</button>
        </div>
      );
    }
    // ── manual payment (v5.6.95, window-local) ────────────────────────────────
    if (phase === 'manual_amount') {
      return (
        <AmountPad
          title="Manual payment"
          hint="Enter the amount"
          pence={manualPence}
          currency="GBP"
          onKey={k => setManualPence(p => padKey(p, k))}
          onOk={minor => { setManualAmountMinor(minor); setPhase('manual_present'); }}
          onBack={() => setPhase('idle')}
        />
      );
    }
    if (phase === 'manual_present') {
      return (
        <div style={sx.center('#fff')}>
          <div style={{ fontSize: 13, color: '#667', letterSpacing: 0.4, textTransform: 'uppercase' }}>Amount</div>
          <div style={sx.bigAmount}>{fmtMinor(manualAmountMinor, 'GBP')}</div>
          <ContactlessGlyph />
          <div style={{ ...sx.h2, fontSize: 19 }}>Present card</div>
          <div style={sx.sub}>{autoTap ? 'Tap, or wait. The demo card taps itself.' : 'Use the operator buttons below.'}</div>
        </div>
      );
    }

    // ── Pay at table (v5.6.95) ────────────────────────────────────────────────
    if (phase === 'tables') {
      return (
        <div style={{ ...sx.fill('#fff'), padding: '22px 16px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...sx.h2, marginTop: 0, fontSize: 19, textAlign: 'center' }}>Pay at table</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {payTables === null ? (
              <>
                <div style={{ ...sx.sub, textAlign: 'center' }}>The table list could not be loaded.</div>
                <button style={sx.tipBtn} onClick={loadTables}>Try again</button>
              </>
            ) : payTables.length === 0 ? (
              <>
                <div style={{ ...sx.sub, textAlign: 'center' }}>No open tables with a balance.</div>
                <button style={sx.tipBtn} onClick={loadTables}>Refresh</button>
              </>
            ) : payTables.map(t => (
              <button key={t.tableId} style={sx.tipBtn} onClick={() => { setPaySel(t); setPhase('paychoice'); }}>
                <span style={{ fontWeight: 700 }}>{t.label}</span>
                <span style={{ color: '#667' }}>{fmtMinor(t.remainingMinor, 'GBP')}</span>
              </button>
            ))}
          </div>
          <button style={{ ...sx.tipBtn, marginTop: 10 }} onClick={() => setPhase('idle')}>Back</button>
        </div>
      );
    }
    if (phase === 'paychoice' && paySel) {
      return (
        <div style={{ ...sx.fill('#fff'), padding: '26px 20px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#667', letterSpacing: 0.4, textTransform: 'uppercase' }}>{paySel.label}</div>
            <div style={sx.bigAmount}>{fmtMinor(paySel.remainingMinor, 'GBP')}</div>
            {paySel.paidMinor > 0 && (
              <div style={sx.sub}>{fmtMinor(paySel.paidMinor, 'GBP')} already paid of {fmtMinor(paySel.billMinor, 'GBP')}</div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
            <button style={sx.tipBtn} onClick={() => wakeupTable(paySel, null)}>
              <span style={{ fontWeight: 700 }}>Pay all</span>
              <span style={{ color: '#667' }}>{fmtMinor(paySel.remainingMinor, 'GBP')}</span>
            </button>
            <button style={sx.tipBtn} onClick={() => { setSplitPence(''); setPhase('split'); }}>
              Split
            </button>
          </div>
          <div style={{ flex: 1 }} />
          <button style={{ ...sx.tipBtn, marginTop: 10 }} onClick={() => setPhase('tables')}>Back</button>
        </div>
      );
    }
    if (phase === 'split' && paySel) {
      return (
        <AmountPad
          title={`Split — ${paySel.label}`}
          hint={`Up to ${fmtMinor(paySel.remainingMinor, 'GBP')}`}
          pence={splitPence}
          currency="GBP"
          onKey={k => setSplitPence(p => padKey(p, k))}
          onOk={minor => wakeupTable(paySel, Math.min(minor, paySel.remainingMinor))}
          onBack={() => setPhase('paychoice')}
        />
      );
    }

    if (phase === 'present' && job) {
      return (
        <div style={sx.center('#fff')}>
          <div style={{ fontSize: 13, color: '#667', letterSpacing: 0.4, textTransform: 'uppercase' }}>Amount</div>
          <div style={sx.bigAmount}>{fmtMinor(job.chargeMinor, job.currency)}</div>
          <ContactlessGlyph />
          <div style={{ ...sx.h2, fontSize: 19 }}>Present card</div>
          <div style={sx.sub}>{autoTap ? 'Tap, or wait. The demo card taps itself.' : 'Use the operator buttons below.'}</div>
        </div>
      );
    }
    if (phase === 'result' && result) {
      const good = result.kind === 'approved';
      const neutral = result.kind === 'cancelled';
      const bg = good ? SIGNAL : neutral ? '#3a3f3d' : DECLINE_RED;
      return (
        <div style={sx.center(bg)}>
          <div style={sx.resultIcon}>
            {good ? (
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none"><path d="M4.5 12.5l5 5 10-11" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            ) : neutral ? (
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M6 12h8" stroke="transparent" /><path d="M5 12h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg>
            ) : (
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg>
            )}
          </div>
          <div style={{ ...sx.h2, color: '#fff', fontSize: 24 }}>
            {good ? 'Approved' : neutral ? 'Cancelled' : 'Declined'}
          </div>
          {result.amountMinor != null && (
            <div style={{ ...sx.bigAmount, color: '#fff', fontSize: 34 }}>{fmtMinor(result.amountMinor, result.currency)}</div>
          )}
          {result.reason && <div style={{ ...sx.sub, color: 'rgba(255,255,255,.85)' }}>{result.reason}</div>}
          {result.note && <div style={{ ...sx.sub, color: 'rgba(255,255,255,.85)', maxWidth: 280 }}>{result.note}</div>}
        </div>
      );
    }
    return <div style={sx.center('#fff')} />;
  })();

  const isManualTap = phase === 'manual_present';
  const canTap = phase === 'present' || isManualTap;
  // Local screens (no job dispatched, nothing server-side to unwind) cancel by
  // simply returning to idle; tip/custom cancel the claimed job via the RPC.
  const localCancel = ['manual_amount', 'manual_present', 'tables', 'paychoice', 'split'].includes(phase);
  const canCancel = phase === 'tip' || phase === 'custom' || localCancel;

  return (
    <div style={sx.page}>
      <style>{RDEMO_CSS}</style>

      {/* Sized to the SCALED footprint so the page's flex centring stays true
          (a transform never changes layout size). The inner column is the
          natural-size prop, measured by propRef and scaled to fit. */}
      <div style={{ width: Math.round(fit.w * fit.scale), height: Math.round(fit.h * fit.scale) }}>
      <div ref={propRef} style={{ width: PROP_W, transform: `scale(${fit.scale})`, transformOrigin: 'top left', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>

      {/* ── the reader ── */}
      <div style={sx.bezel}>
        <div style={sx.speaker} />
        <div style={sx.screenWrap}>
          {screen}
          {err && phase !== 'fatal' && (
            <div style={sx.errStrip} onClick={() => setErr('')} title="Tap to dismiss">
              {err}
            </div>
          )}
        </div>
        <div style={sx.homeBar} />
      </div>

      {/* ── operator strip (not part of the "reader") ── */}
      <div style={sx.opsStrip}>
        <button style={{ ...sx.opsBtn, opacity: canTap ? 1 : 0.35 }} disabled={!canTap} onClick={() => (isManualTap ? settleManual('approved') : settle('approved'))}>
          💳 Tap card
        </button>
        <button style={{ ...sx.opsBtn, opacity: canTap ? 1 : 0.35 }} disabled={!canTap} onClick={() => (isManualTap ? settleManual('declined') : settle('declined'))}>
          ⛔ Decline
        </button>
        <button
          style={{ ...sx.opsBtn, opacity: canCancel ? 1 : 0.35 }}
          disabled={!canCancel}
          title={canCancel ? 'Customer walks away (before the card)' : 'Only before the card screen. Once dispatched, use Decline'}
          onClick={() => { if (localCancel) { setErr(''); setPhase('idle'); } else cancelPreDispatch(); }}
        >
          ✕ Cancel
        </button>
        <label style={sx.opsToggle}>
          <input type="checkbox" checked={autoTap} onChange={e => setAutoTapPersist(e.target.checked)} />
          Auto-tap
        </label>
      </div>

      {/* ── status line ── */}
      <div style={sx.statusLine}>
        <span className="rdemo-dot" style={{ background: online ? SIGNAL : DECLINE_RED }} />
        {isPaired
          ? <>Paired{ownRow?.label ? <> as <b>{ownRow.label}</b></> : null} · {bound
              ? 'assigned to a till'
              : 'not assigned. Bind me to a till in Back Office → Card readers'}</>
          : 'Not paired yet'}
        <span style={{ opacity: 0.55 }}> · {serialRef.current} · v{VERSION}</span>
      </div>
      <div style={{ ...sx.statusLine, fontSize: 11, opacity: 0.55, marginTop: 4 }}>
        Demo reader. Payments settle as simulated card sales marked DEMO. Real readers are unaffected.
      </div>

      </div>
      </div>
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const sx = {
  page: {
    // v5.6.94: fixed-height, no scrolling — the prop column is transform-scaled
    // to fit (see the fit-to-viewport effect), so nothing can fall below the fold.
    height: '100vh',
    overflow: 'hidden',
    background: 'linear-gradient(180deg, #eef1f0 0%, #dde3e0 100%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    boxSizing: 'border-box',
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
    color: INK,
  },
  bezel: {
    width: '100%',
    height: 700,
    boxSizing: 'border-box',
    background: INK,
    borderRadius: 44,
    padding: '26px 14px 22px',
    boxShadow: '0 24px 60px rgba(15,18,17,.35), inset 0 0 0 2px rgba(255,255,255,.06)',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  speaker: {
    width: 64, height: 5, borderRadius: 3,
    background: 'rgba(255,255,255,.14)',
    margin: '0 auto 14px',
  },
  homeBar: {
    width: 110, height: 4, borderRadius: 2,
    background: 'rgba(255,255,255,.22)',
    margin: '14px auto 0',
  },
  screenWrap: {
    flex: 1,
    borderRadius: 24,
    overflow: 'hidden',
    position: 'relative',
    background: '#fff',
  },
  fill: (bg) => ({ position: 'absolute', inset: 0, background: bg, overflowY: 'auto' }),
  center: (bg) => ({
    position: 'absolute', inset: 0, background: bg,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', padding: 24, gap: 6,
  }),
  logo: { width: '62%', maxWidth: 220, objectFit: 'contain' },
  h2: { fontSize: 21, fontWeight: 700, marginTop: 10, color: 'inherit' },
  sub: { fontSize: 14, color: '#556', lineHeight: 1.45, marginTop: 6 },
  claimCode: {
    fontSize: 44, fontWeight: 800, letterSpacing: 6,
    fontVariantNumeric: 'tabular-nums',
    margin: '18px 0 10px', wordBreak: 'break-all',
  },
  bigAmount: {
    fontSize: 42, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
    letterSpacing: -0.5, marginTop: 2,
  },
  tipBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: '15px 18px',
    borderRadius: 14, border: '1.5px solid #d8ddda', background: '#fff',
    fontSize: 17, fontWeight: 600, color: INK, cursor: 'pointer',
  },
  idleBtn: {
    // The two reader-initiated flows, on the green idle screen (v5.6.95).
    padding: '13px 16px', borderRadius: 14,
    border: '1.5px solid rgba(255,255,255,.55)', background: 'rgba(255,255,255,.14)',
    color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer',
  },
  keypadBtn: {
    borderRadius: 14, border: '1.5px solid #d8ddda', background: '#fff',
    fontSize: 22, fontWeight: 600, color: INK, cursor: 'pointer', minHeight: 54,
  },
  resultIcon: {
    width: 92, height: 92, borderRadius: '50%',
    border: '3px solid rgba(255,255,255,.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  errStrip: {
    position: 'absolute', left: 10, right: 10, bottom: 10,
    background: '#7a1d1d', color: '#fff',
    borderRadius: 10, padding: '9px 12px',
    fontSize: 12.5, lineHeight: 1.4, cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,.3)',
  },
  opsStrip: {
    // v5.6.94: attached directly under the bezel at the same width so it reads
    // as part of the prop (and so the column's natural size is deterministic
    // for the fit-to-viewport measurement).
    display: 'flex', gap: 8, alignItems: 'center',
    marginTop: 10, flexWrap: 'wrap', justifyContent: 'center',
    width: '100%', boxSizing: 'border-box', padding: '10px 12px',
    background: '#fff', border: '1px solid #d8ddda', borderRadius: 16,
    boxShadow: '0 10px 26px rgba(15,18,17,.14)',
  },
  opsBtn: {
    padding: '8px 10px', borderRadius: 10,
    border: '1px solid #c6ccc9', background: '#fff',
    fontSize: 13, fontWeight: 600, color: INK, cursor: 'pointer',
  },
  opsToggle: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 13, color: '#445', userSelect: 'none', cursor: 'pointer',
  },
  statusLine: {
    marginTop: 12, fontSize: 12.5, color: '#445',
    display: 'flex', alignItems: 'center', gap: 6, textAlign: 'center', flexWrap: 'wrap', justifyContent: 'center',
  },
  pulseDotRow: {
    marginTop: 18, fontSize: 13, color: '#667',
    display: 'flex', alignItems: 'center', gap: 8,
  },
};

const RDEMO_CSS = `
.rdemo-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: ${SIGNAL}; animation: rdemo-pulse 1.6s ease-in-out infinite;
  vertical-align: middle;
}
@keyframes rdemo-pulse {
  0%, 100% { opacity: 1; } 50% { opacity: .35; }
}
.rdemo-spinner {
  width: 34px; height: 34px; border-radius: 50%;
  border: 3px solid #dfe4e1; border-top-color: ${SIGNAL};
  animation: rdemo-spin .8s linear infinite;
}
@keyframes rdemo-spin { to { transform: rotate(360deg); } }
.rdemo-contactless { position: relative; width: 120px; height: 120px;
  display: flex; align-items: center; justify-content: center; }
.rdemo-contactless > span {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid ${SIGNAL}; opacity: 0;
  animation: rdemo-ripple 2.2s ease-out infinite;
}
.rdemo-contactless > span:nth-child(2) { animation-delay: .55s; }
.rdemo-contactless > span:nth-child(3) { animation-delay: 1.1s; }
@keyframes rdemo-ripple {
  0% { transform: scale(.45); opacity: .8; }
  100% { transform: scale(1.15); opacity: 0; }
}
`;
