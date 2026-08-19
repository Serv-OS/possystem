// src/backoffice/sections/UnresolvedPayments.jsx
//
// The reconciliation queue for card payments whose outcome was never established.
//
// WHY THIS SCREEN EXISTS
//   A PAX job that is dispatched to the card but never reports back lands in
//   status 'unknown'. It is NOT in flight — it is SETTLED BUT UNVERIFIED. Until
//   20260725 that state also sat in idx_tj_one_live_per_terminal, so one
//   unresolved payment took the whole terminal out of service until somebody ran
//   SQL by hand. That index no longer lists 'unknown', which means the terminal
//   keeps trading — and the unresolved payment needs somewhere to go instead.
//   This is that somewhere.
//
//   The double-charge fence for an unverified payment has NOT moved: it is still
//   on check_key in terminal_start_table_payment, so nobody can start a second
//   payment against the same bill while this row is open.
//
// SECURITY NOTE — nothing here writes terminal_jobs directly. That table has NO
// INSERT, UPDATE or DELETE POLICY at all, deliberately: every anonymous
// kiosk/QR/online session in this system holds a valid auth.uid(), so a
// permissive policy on a payments table would be unbounded public write access.
// A supabase.from('terminal_jobs').update(...) here would silently affect 0 rows.
//
//   READ  — policy tj_select_bo: location_id in the caller's user_locations, or
//           super_admin. That is the whole read fence and it is enough for this
//           screen; no filter here can widen it.
//   WRITE — resolve_terminal_job() (20260726), a SECURITY DEFINER RPC fenced on
//           _terminal_user_has_location(), granted to `authenticated` and NOT to
//           anon. It is the ONLY write this screen makes.
//
// WHY NOT terminal_job_reconcile() / the terminal-job-reconcile edge function:
//   both are service_role only — the function byte-compares the bearer against
//   SUPABASE_SERVICE_ROLE_KEY. Correct for a sweeper, useless for a person. The
//   only ways to drive them from here were to ship the service-role key to the
//   browser (hands every visitor the whole database) or to loosen the sweeper's
//   own fence. resolve_terminal_job is the third door: same verdicts, fenced on
//   the manager's venue instead of on a shared secret.
//
// ATTRIBUTION IS SERVER-SIDE. The RPC resolves the caller's email from
// user_profiles and stamps "<outcome> — confirmed by <email> at <time>: <note>"
// onto the row itself. Do NOT rebuild that string here — a client-composed
// identity is a claim, not a fact, and this is a judgement about real money.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';
import { moneyMinor } from '../../lib/currency';

const S = {
  card:    { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:20 },
  h2:      { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc:    { fontSize:12, color:'var(--t4)', marginBottom:16, lineHeight:1.6 },
  label:   { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input:   { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  btn:     { padding:'9px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrim: { background:'var(--acc)', color:'#0b0c10' },
  btnGhost:{ background:'transparent', color:'var(--t2)', border:'1px solid var(--bdr)' },
  btnDan:  { background:'transparent', color:'var(--red)', border:'1px solid var(--red-b)' },
  err:     { padding:10, background:'var(--red-d)', color:'var(--red)', borderRadius:8, fontSize:12, border:'1px solid var(--red-b)', marginTop:10 },
  ok:      { padding:10, background:'var(--bg2)', color:'var(--grn)', borderRadius:8, fontSize:12, border:'1px solid var(--bdr)', marginTop:10 },
  pill:    { fontSize:11, padding:'2px 8px', borderRadius:99, background:'var(--bg3)', color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.05em', fontWeight:700, border:'1px solid var(--bdr)' },
  mono:    { fontFamily:'var(--font-mono, monospace)' },
  sub:     { fontSize:11, color:'var(--t4)', marginTop:6, lineHeight:1.5 },
  box:     { padding:12, background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8, marginBottom:12 },
  fieldset:{ marginTop:18, paddingTop:16, borderTop:'1px solid var(--bdr)' },
  legend:  { fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 },
};

// ── The three verdicts ───────────────────────────────────────────────────────
// Each one is an assertion about real money that the manager may get wrong, so
// each says what to CHECK first and what happens if the answer is wrong. The
// outcome strings are the ones resolve_terminal_job accepts; the wording is
// what a manager reads.
const VERDICTS = {
  charged: {
    outcome: 'approved',
    button:  'Customer was charged',
    confirm: 'Confirm — the customer was charged',
    title:   'Mark this payment as TAKEN',
    check:   'Check your card statement, or your payment provider’s own dashboard, and find this payment before you continue. The terminal never confirmed it, so nothing in this system knows whether the money moved.',
    effect:  'This records that the money WAS taken from the customer and closes the payment.',
    risk:    'If you are wrong, the bill is marked paid when nobody has paid it, and the takings will not match the bank.',
  },
  notCharged: {
    outcome: 'cancelled',
    button:  'Customer was not charged',
    confirm: 'Confirm — the customer was not charged',
    title:   'Mark this payment as NOT TAKEN',
    check:   'Check your card statement, or your payment provider’s own dashboard, and confirm there is no payment there before you continue. The card was asked to charge, so it may well have gone through.',
    effect:  'This records that NO money was taken. The bill is still owed and has to be collected again.',
    risk:    'If you are wrong, the customer has already paid and taking it again charges them twice.',
  },
  declined: {
    outcome: 'declined',
    button:  'Declined',
    confirm: 'Confirm — the card was declined',
    title:   'Mark this payment as DECLINED',
    check:   'Check your payment provider’s own dashboard and confirm it shows the card being refused before you continue.',
    effect:  'This records that the card was refused and no money was taken. The bill is still owed and has to be collected again.',
    risk:    'If you are wrong, the customer has already paid and taking it again charges them twice.',
  },
};

// ── The fourth outcome, which is not a verdict ───────────────────────────────
// A job can carry needs_human while its outcome is perfectly well known:
// terminal_report_result flags an APPROVED payment when the amount the device
// reported disagrees with the amount the server computed. There is nothing to
// decide there — the money moved, and everyone knows it moved. What is unresolved
// is a DISCREPANCY, and the manager is signing off having looked at it.
//
// So this is framed as an acknowledgement, not a judgement. resolve_terminal_job
// treats it the same way: for 'acknowledged' it clears needs_human and records
// the note but deliberately leaves `status` alone.
const ACKNOWLEDGE = {
  outcome: 'acknowledged',
  button:  'I have checked this amount',
  confirm: 'I have checked this amount',
  title:   'Sign off this amount difference',
  check:   'The payment itself is not in doubt — it went through and the outcome is known. What does not match is the amount: the terminal reported one figure and this system worked out another. Compare both against your payment provider’s dashboard and find which one actually left the customer’s card.',
  effect:  'This records that you have looked at the difference, and takes the payment off this list. It does NOT change the payment, the amount taken, or what the customer was charged — no money moves.',
  risk:    'Signing off does not put a real difference right. If the customer was charged the wrong amount, that still needs a refund or a correction with your payment provider.',
};

function when(ts) {
  if (!ts) return 'Time unknown';
  const d = new Date(ts);
  const age = Date.now() - d.getTime();
  const mins = Math.round(age / 60_000);
  const stamp = d.toLocaleString(undefined, { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  if (mins < 1)  return `${stamp} (just now)`;
  if (mins < 60) return `${stamp} (${mins}m ago)`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48)  return `${stamp} (${hrs}h ago)`;
  return `${stamp} (${Math.round(hrs / 24)} days ago)`;
}

/** The money at stake: what was actually sent to the card, or the bill if no tip was committed. */
function amountOf(j) {
  return (j.charge_minor ?? j.due_minor ?? 0);
}

/** Plain-English version of whatever the machine last said. */
function reasonOf(j) {
  const bits = [j.decline_reason, j.last_error].filter(Boolean);
  if (!bits.length) return 'The terminal stopped responding before it said what happened.';
  return bits.join(' · ');
}

export default function UnresolvedPayments() {
  const [locationId, setLocationId] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [labels, setLabels] = useState({});     // terminal id -> label
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState(null);   // which job's confirm panel is expanded

  const load = async () => {
    setError('');
    try {
      const locId = getActiveLocationSync();
      if (!locId || locId === 'loc-demo') { setLoading(false); return; }
      setLocationId(locId);

      // RLS (tj_select_bo) scopes this to the manager's own locations — the
      // location_id filter narrows, it cannot widen.
      const { data, error: e } = await supabase
        .from('terminal_jobs')
        .select('id, status, needs_human, charge_minor, due_minor, tip_minor, reported_minor, currency, ' +
                'transaction_id, auth_code, card, decline_reason, last_error, check_draft, ' +
                'target_terminal_id, created_at, charged_at, settled_at')
        .eq('location_id', locId)
        .or('status.eq.unknown,needs_human.is.true')
        .order('charged_at', { ascending: false, nullsFirst: false })
        .limit(200);
      if (e) throw new Error(e.message);
      const rows = data || [];
      setJobs(rows);

      // Which machine took it. Separate query rather than a PostgREST embed so
      // the terminal read is fenced by td_select on its own terms.
      if (rows.length) {
        const { data: devs } = await supabase
          .from('terminal_devices')
          .select('id, label')
          .eq('location_id', locId);
        const map = {};
        (devs || []).forEach(d => { map[d.id] = d.label; });
        setLabels(map);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  // Refresh periodically, but never underneath an open confirmation — a manager
  // mid-decision about real money must not have the row move.
  useEffect(() => {
    const t = setInterval(() => { if (!openId) load(); }, 30_000);
    return () => clearInterval(t);
  }, [openId]);

  if (loading) return null;
  if (!locationId) return null;
  if (jobs.length === 0) return null;   // nothing unresolved: show nothing at all

  return (
    <div style={S.card}>
      <div style={S.h2}>⚠️ Payments that need checking</div>
      <div style={S.desc}>
        Card payments that need a person to look at them. Most finished without the terminal ever saying
        what happened, so nobody knows whether the customer was charged; a few went through but for an
        amount that does not match what we worked out. The card machines carry on working normally &mdash;
        these are parked here instead. Look each one up on your card statement or in your payment
        provider&rsquo;s dashboard, then say what you found. Until an unconfirmed payment is settled here,
        that table&rsquo;s bill cannot be taken again, so the customer cannot be charged twice by mistake.
      </div>

      <div style={{ border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'auto 1.6fr 1.2fr auto', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.04em', padding:'9px 14px', background:'var(--bg2)' }}>
          <div>Amount</div><div>Table &amp; terminal</div><div>Reference</div><div></div>
        </div>
        {jobs.map(j => (
          <JobRow
            key={j.id}
            job={j}
            terminalLabel={labels[j.target_terminal_id]}
            open={openId === j.id}
            onToggle={() => setOpenId(openId === j.id ? null : j.id)}
            onResolved={async (msg) => { setNotice(msg); setOpenId(null); await load(); }}
          />
        ))}
      </div>

      {notice && <div style={S.ok}>{notice}</div>}
      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}

// ─── One unresolved payment ───────────────────────────────────────────────────
function JobRow({ job, terminalLabel, open, onToggle, onResolved }) {
  const [verdict, setVerdict] = useState(null);   // key into VERDICTS
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const draft = (job.check_draft && typeof job.check_draft === 'object') ? job.check_draft : {};
  const tableLabel = draft.tableLabel || draft.tableId || null;   // camelCase: written by the POS
  const card = (job.card && typeof job.card === 'object') ? job.card : {};
  const last4 = card.last4 || card.pan_last4 || null;
  const brand = card.brand || card.scheme || null;

  // TWO DIFFERENT JOBS ON ONE LIST.
  //   'unknown'                       — nobody knows if money moved. A verdict.
  //   needs_human on a settled status — the outcome is known, the AMOUNT is not.
  //                                     An acknowledgement, handled separately.
  const decidable = job.status === 'unknown';

  // Both figures for the mismatch case. reported_minor is what the device
  // claimed; charge_minor is what the server computed and is the authority.
  const reported = job.reported_minor;
  const charged  = job.charge_minor;
  const showsMismatch = !decidable && reported != null && charged != null && reported !== charged;

  const resolve = async (cfg) => {
    if (!cfg) return;
    setBusy(true); setErr('');
    try {
      // Attribution is the RPC's job — it resolves the caller's email from
      // user_profiles and stamps it onto the row. We pass only what the manager
      // actually typed.
      const { data, error } = await supabase.rpc('resolve_terminal_job', {
        p_job_id:  job.id,
        p_outcome: cfg.outcome,
        p_note:    note.trim() || null,
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) {
        throw new Error(data?.reason || 'This payment was not updated — somebody else may have already resolved it. Refresh and check.');
      }
      await onResolved(`Recorded: ${cfg.title.toLowerCase()}.`);
    } catch (e) {
      setErr(e?.message || 'The decision was not saved.');
    } finally {
      setBusy(false);
    }
  };

  const v = decidable ? (verdict ? VERDICTS[verdict] : null) : ACKNOWLEDGE;

  return (
    <div style={{ borderTop:'1px solid var(--bdr)' }}>
      <div style={{ display:'grid', gridTemplateColumns:'auto 1.6fr 1.2fr auto', fontSize:13, padding:'10px 14px', alignItems:'center', gap:12 }}>
        <div style={{ fontWeight:800, color:'var(--t1)', fontSize:15, whiteSpace:'nowrap' }}>
          {moneyMinor(amountOf(job), job.currency)}
          {job.tip_minor > 0 && (
            <div style={{ fontSize:11, fontWeight:600, color:'var(--t4)' }}>
              incl. {moneyMinor(job.tip_minor, job.currency)} tip
            </div>
          )}
        </div>

        <div>
          <div style={{ color:'var(--t1)', fontWeight:600 }}>
            {tableLabel ? `Table ${tableLabel}` : 'No table — payment taken on the terminal'}
          </div>
          <div style={{ fontSize:11, color:'var(--t4)' }}>
            {terminalLabel || 'Terminal no longer paired'}
            {' · '}
            {when(job.charged_at || job.settled_at || job.created_at)}
          </div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{reasonOf(job)}</div>
        </div>

        <div style={{ ...S.mono, fontSize:11, color:'var(--t2)', wordBreak:'break-all' }}>
          {job.transaction_id ? <div>Txn {job.transaction_id}</div> : null}
          {job.auth_code ? <div>Auth {job.auth_code}</div> : null}
          {last4 ? <div>{[brand, `•••• ${last4}`].filter(Boolean).join(' ')}</div> : null}
          {!job.transaction_id && !job.auth_code && !last4 && (
            <span style={{ color:'var(--t4)' }}>No reference — search by amount and time</span>
          )}
        </div>

        <div style={{ textAlign:'right' }}>
          <button onClick={onToggle} style={{ ...S.btn, ...S.btnGhost, padding:'5px 10px', fontSize:12 }}>
            {open ? 'Close' : decidable ? 'What happened?' : 'Check this amount'}
          </button>
        </div>
      </div>

      {open && (
        <div style={{ padding:'4px 14px 18px', background:'var(--bg2)', borderTop:'1px solid var(--bdr)' }}>
          <div style={S.fieldset}>

            {decidable ? (
              <>
                <div style={S.legend}>What actually happened to this payment?</div>
                <div style={{ ...S.sub, marginBottom:12 }}>
                  Look it up first: {moneyMinor(amountOf(job), job.currency)} on{' '}
                  {when(job.charged_at || job.settled_at || job.created_at)}
                  {job.transaction_id ? `, reference ${job.transaction_id}` : ''}. Whatever you choose is
                  recorded against your name.
                </div>

                <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
                  {Object.entries(VERDICTS).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => { setVerdict(verdict === key ? null : key); setErr(''); }}
                      style={{
                        ...S.btn,
                        ...(verdict === key ? S.btnPrim : S.btnGhost),
                        padding:'7px 14px', fontSize:12,
                      }}
                    >
                      {cfg.button}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={S.legend}>The amounts do not match</div>
                <div style={{ ...S.sub, marginBottom:12 }}>
                  This payment went through &mdash; it was recorded as <strong>{job.status}</strong>. What is
                  unresolved is the amount: the terminal reported one figure and this system worked out
                  another. Nothing here decides whether money moved; it already did.
                </div>

                {/* Both figures, plainly, side by side — the manager is signing
                    off a specific difference and should be able to see it. */}
                <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:12 }}>
                  <div style={{ ...S.box, flex:'1 1 180px', marginBottom:0 }}>
                    <div style={S.label}>The terminal reported</div>
                    <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)' }}>
                      {reported == null ? '—' : moneyMinor(reported, job.currency)}
                    </div>
                  </div>
                  <div style={{ ...S.box, flex:'1 1 180px', marginBottom:0 }}>
                    <div style={S.label}>We charged</div>
                    <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)' }}>
                      {charged == null ? '—' : moneyMinor(charged, job.currency)}
                    </div>
                  </div>
                  {showsMismatch && (
                    <div style={{ ...S.box, flex:'1 1 180px', marginBottom:0, borderColor:'var(--red-b)' }}>
                      <div style={S.label}>Difference</div>
                      <div style={{ fontSize:20, fontWeight:800, color:'var(--red)' }}>
                        {(reported > charged ? '+' : '−') + moneyMinor(Math.abs(reported - charged), job.currency)}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {v && (
              <div style={S.box}>
                <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>{v.title}</div>
                <div style={{ fontSize:12, color:'var(--t2)', lineHeight:1.6, marginBottom:8 }}>{v.check}</div>
                <div style={{ fontSize:12, color:'var(--t2)', lineHeight:1.6, marginBottom:8 }}>{v.effect}</div>
                <div style={{ fontSize:12, color:'var(--red)', lineHeight:1.6 }}>{v.risk}</div>

                <div style={{ marginTop:14 }}>
                  <label style={S.label}>What did you check? (optional)</label>
                  <input
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="e.g. found on the card processor dashboard, 21 Jul 19:42"
                    maxLength={200}
                    style={S.input}
                  />
                  <div style={S.sub}>Kept with the payment so the decision can be explained later.</div>
                </div>

                <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                  {/* Danger styling for the three verdicts — they assert whether
                      money moved. Signing off a difference does not, so it is a
                      normal action and should not look like one. */}
                  <button
                    onClick={() => resolve(v)}
                    disabled={busy}
                    style={{ ...S.btn, ...(decidable ? S.btnDan : S.btnPrim) }}
                  >
                    {busy ? 'Recording…' : v.confirm}
                  </button>
                  {decidable && (
                    <button onClick={() => setVerdict(null)} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}

            {err && <div style={S.err}>{err}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
