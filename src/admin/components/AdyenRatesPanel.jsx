// src/admin/components/AdyenRatesPanel.jsx
//
// THE RATES ON ADYEN, FROM THE CARD RATES BOX (15 Oct 2026). Three panels under
// the rate card editor on a venue's Processing page, all actions on
// adyen-terminal-admin (super_admin, behind the second step check):
//   1. Read what Adyen charges   read_split, GET only. One plain line per rule
//                                on the store now, the refund line, the diff
//                                against the rate card, and the ledger side.
//   2. Write these rates to Adyen  preview_split, then set_split with the typed
//                                word LIVE on a live venue. The preview shows the
//                                before and after rule by rule and the refund
//                                rule in bold. The send writes a new profile,
//                                points the store at it, reads it back and keeps
//                                it on the venue with the cutover instant.
//   3. Switch on card type data  webhook_settings read, write (typed ON) and
//                                check. If Adyen shows no setting key the exact
//                                Customer Area clicks are shown instead.
// Saving the rate card never touches Adyen; only panel 2 does, on a press.
// OWNER RULE: plain words, no dashes, body text 15px or more.
//
// Props:
//   callAdmin  (action, payload) => answer, adyen-terminal-admin for this venue
//   rates      payments-admin adyen_pricing's `rates` block (live_at, latest, ready, migration_file) or null
//   live       the venue takes real cards (the typed word is asked)
//   onWritten  () => void after a successful write, so the box reads again

import { useState } from 'react';

const T = {
  title: { fontSize: 15, fontWeight: 700, color: 'var(--t1)', margin: '0 0 4px' },
  plain: { fontSize: 15, color: 'var(--t2)', lineHeight: 1.5, margin: 0 },
  quiet: { fontSize: 15, color: 'var(--t3)', lineHeight: 1.5, margin: 0 },
  bold: { fontSize: 15, color: 'var(--t1)', lineHeight: 1.5, margin: 0, fontWeight: 700 },
  warn: { fontSize: 15, color: 'var(--orn, #e8a020)', lineHeight: 1.5, margin: 0 },
  bad: { fontSize: 15, color: 'var(--red)', lineHeight: 1.5, margin: 0 },
  ok: { fontSize: 15, color: 'var(--grn)', lineHeight: 1.5, margin: 0 },
  mono: { fontFamily: 'var(--font-mono, monospace)', fontSize: 13, color: 'var(--t2)', wordBreak: 'break-all' },
  btn: { padding: '10px 16px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t1)', cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit', minHeight: 44 },
  prim: { padding: '10px 16px', borderRadius: 8, border: 'none', background: 'var(--acc)', color: '#0b0c10', cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit', minHeight: 44 },
  live: { padding: '10px 16px', borderRadius: 8, border: 'none', background: 'var(--red)', color: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit', minHeight: 44 },
  link: { background: 'none', border: 'none', padding: 0, color: 'var(--acc)', cursor: 'pointer', fontSize: 15, fontFamily: 'inherit' },
  input: { padding: '10px 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'var(--font-mono, monospace)', letterSpacing: '.1em', outline: 'none', minHeight: 44, boxSizing: 'border-box', width: 160 },
  panel: { marginTop: 14, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--bdr2)', background: 'var(--bg3, rgba(127,127,127,.06))' },
  row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
  list: { margin: '6px 0 0', paddingLeft: 18, fontSize: 15, color: 'var(--t2)', lineHeight: 1.6 },
};

const disabled = (busy) => (busy ? { opacity: 0.6, cursor: 'default' } : {});
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const lines = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A list of lines, folded past `show` with one toggle.
function Lines({ items, show = 10, label = 'rules' }) {
  const [open, setOpen] = useState(false);
  const all = lines(items);
  if (!all.length) return null;
  const visible = open || all.length <= show ? all : all.slice(0, show);
  return (
    <div>
      <ul style={T.list}>{visible.map((l, i) => <li key={`${i}:${l}`}>{l}</li>)}</ul>
      {all.length > show && (
        <button type="button" style={{ ...T.link, marginTop: 4 }} onClick={() => setOpen((v) => !v)}>
          {open ? `Show fewer ${label}` : `Show all ${plural(all.length, label.replace(/s$/, ''), label)}`}
        </button>
      )}
    </div>
  );
}

function Problem({ text, detail }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <p style={T.bad}>{text}</p>
      {detail && (
        <>
          <button type="button" style={T.link} onClick={() => setOpen((v) => !v)}>{open ? 'Hide detail' : 'Show detail'}</button>
          {open && <p style={{ ...T.mono, marginTop: 4 }}>{detail}</p>}
        </>
      )}
    </div>
  );
}

// The answer of a failed call as one sentence and its detail.
const problemOf = (r, fallback) => ({ text: str(r?.error) || fallback, detail: str(r?.detail) || null });
const caught = (e, fallback) => ({ text: str(e?.data?.error) || str(e?.message) || fallback, detail: str(e?.data?.detail) || null });

export default function AdyenRatesPanel({ callAdmin, rates, live, onWritten }) {
  // ── 1. Read ─────────────────────────────────────────────────────────────────
  const [read, setRead] = useState(null);        // read_split answer
  const [readBusy, setReadBusy] = useState(false);
  const [readProblem, setReadProblem] = useState(null);
  const doRead = async () => {
    setReadBusy(true); setReadProblem(null);
    try {
      const r = await callAdmin('read_split', {});
      if (r?.ok === false) { setRead(null); setReadProblem(problemOf(r, 'Adyen could not be read.')); }
      else setRead(r);
    } catch (e) {
      setRead(null);
      setReadProblem(/unknown action/i.test(`${str(e?.data?.error)} ${str(e?.message)}`)
        ? { text: 'Reading the rates needs a server update first.', detail: 'Deploy the adyen-terminal-admin function, then press Read again.' }
        : caught(e, 'Adyen could not be read.'));
    } finally { setReadBusy(false); }
  };

  // ── 2. Write ────────────────────────────────────────────────────────────────
  const [preview, setPreview] = useState(null);  // preview_split answer
  const [typed, setTyped] = useState('');
  const [writeBusy, setWriteBusy] = useState(null);   // 'preview' | 'send' | null
  const [writeProblem, setWriteProblem] = useState(null);
  const [written, setWritten] = useState(null);  // set_split answer
  const [showSent, setShowSent] = useState(false);
  const doPreview = async () => {
    setWriteBusy('preview'); setWriteProblem(null); setWritten(null); setPreview(null); setTyped(''); setShowSent(false);
    try {
      const r = await callAdmin('preview_split', {});
      if (r?.ok === false || r?.dry_run !== true || r?.sent !== false) setWriteProblem(problemOf(r, 'The rates could not be previewed.'));
      else setPreview(r);
    } catch (e) { setWriteProblem(caught(e, 'The rates could not be previewed.')); }
    finally { setWriteBusy(null); }
  };
  const needsTyped = preview ? preview.live === true : live === true;
  const typedOk = !needsTyped || typed.trim().toUpperCase() === 'LIVE';
  const p = preview?.preview || {};
  const canSend = !!preview && !preview.profileUnread && p.canSend !== false && p.same !== true && preview.rulesColumnsReady !== false && !!preview.fingerprint;
  const doSend = async () => {
    if (!preview || !typedOk) return;
    setWriteBusy('send'); setWriteProblem(null);
    try {
      const r = await callAdmin('set_split', {
        preview_fingerprint: preview.fingerprint,
        ...(lines(preview.overLimit).length ? { over_limit: true } : {}),
        ...(needsTyped ? { confirm_live: 'LIVE' } : {}),
      });
      if (r?.ok === false) {
        if (r.changed || r.needs_preview) { setPreview(null); setTyped(''); }
        setWriteProblem(problemOf(r, 'The rates could not be written.'));
      } else {
        setWritten(r); setPreview(null); setTyped('');
        if (typeof onWritten === 'function') onWritten();
      }
    } catch (e) { setWriteProblem(caught(e, 'The rates could not be written.')); }
    finally { setWriteBusy(null); }
  };

  // ── 3. Card type data ───────────────────────────────────────────────────────
  const [hooks, setHooks] = useState(null);      // webhook_settings read answer
  const [hookBusy, setHookBusy] = useState(null);
  const [hookProblem, setHookProblem] = useState(null);
  const [picked, setPicked] = useState({});      // key -> true
  const [onTyped, setOnTyped] = useState('');
  const [switched, setSwitched] = useState(null);
  const [checkSince, setCheckSince] = useState(null);
  const [check, setCheck] = useState(null);
  const doHooksRead = async () => {
    setHookBusy('read'); setHookProblem(null); setSwitched(null);
    try {
      const r = await callAdmin('webhook_settings', { step: 'read' });
      if (r?.ok === false) setHookProblem(problemOf(r, 'The webhooks could not be read.'));
      else {
        setHooks(r);
        const next = {};
        for (const h of r.hooks || []) if (h.ours) for (const c of h.candidates || []) next[`${h.id}|${c.key}`] = true;
        setPicked(next);
      }
    } catch (e) { setHookProblem(caught(e, 'The webhooks could not be read.')); }
    finally { setHookBusy(null); }
  };
  const ours = (hooks?.hooks || []).filter((h) => h.ours);
  const others = (hooks?.hooks || []).filter((h) => !h.ours);
  const candidateHooks = ours.filter((h) => (h.candidates || []).length);
  const onOk = live !== true || onTyped.trim().toUpperCase() === 'ON';
  const doSwitch = async (hook) => {
    const keys = (hook.candidates || []).map((c) => c.key).filter((k) => picked[`${hook.id}|${k}`]);
    if (!keys.length || !onOk) return;
    setHookBusy('write'); setHookProblem(null);
    try {
      const r = await callAdmin('webhook_settings', { step: 'write', webhook_id: hook.id, keys, ...(live === true ? { confirm: 'ON' } : {}) });
      if (r?.ok === false) setHookProblem(problemOf(r, 'The settings could not be switched on.'));
      else { setSwitched(r); setHooks((prev) => ({ ...(prev || {}), hooks: r.hooks || prev?.hooks || [] })); setCheckSince(new Date().toISOString()); setOnTyped(''); }
    } catch (e) { setHookProblem(caught(e, 'The settings could not be switched on.')); }
    finally { setHookBusy(null); }
  };
  const doCheck = async () => {
    setHookBusy('check'); setHookProblem(null);
    try {
      const since = checkSince || new Date(Date.now() - 86400000).toISOString();
      const r = await callAdmin('webhook_settings', { step: 'check', since });
      if (r?.ok === false) setHookProblem(problemOf(r, 'The check could not be run.'));
      else setCheck(r);
    } catch (e) { setHookProblem(caught(e, 'The check could not be run.')); }
    finally { setHookBusy(null); }
  };

  const liveAt = rates?.live_at || read?.ratesLiveAt || written?.ratesLiveAt || null;
  const ledger = read?.ledger || null;

  return (
    <div>
      {/* The state in one line, from what the box already knows. */}
      <div style={{ marginTop: 14 }}>
        {rates?.ready === false && (
          <p style={T.warn}>One database update is waiting on ServOS before the rates can be written: {rates.migration_file}.</p>
        )}
        {liveAt
          ? <p style={T.plain}>New payments are charged and recorded from the rules on Adyen since {when(liveAt)}.{rates?.latest?.rules ? ` The venue holds ${plural(rates.latest.rules, 'rule', 'rules')} read back from Adyen.` : ''}</p>
          : <p style={T.quiet}>The rates have not been written to Adyen under the new rules yet. New payments are still recorded the old way.</p>}
      </div>

      {/* ── 1. Read what Adyen charges ── */}
      <div style={T.panel}>
        <p style={T.title}>What Adyen charges now</p>
        <p style={T.quiet}>Reads the rules on the venue's payments location and compares them with the card above. Nothing is changed.</p>
        <div style={T.row}>
          <button type="button" style={{ ...T.btn, ...disabled(readBusy) }} disabled={readBusy} onClick={doRead}>{readBusy ? 'Reading Adyen' : 'Read what Adyen charges'}</button>
          {read?.profileIdNow && <span style={T.mono}>{read.profileIdNow}</span>}
        </div>
        <Problem text={readProblem?.text} detail={readProblem?.detail} />
        {read && (
          <div style={{ marginTop: 10 }}>
            {read.profileUnread && <p style={T.warn}>The rules on Adyen could not be read. {read.profileUnreadDetail}</p>}
            {!read.profileUnread && !read.profileIdNow && <p style={T.warn}>The payments location has no rules on it. Adyen takes nothing for ServOS on this venue.</p>}
            {!read.profileUnread && read.profileIdNow && (
              <>
                <p style={T.plain}>{plural(read.rules, 'rule', 'rules')} on the payments location{read.rowProfileId && read.rowProfileId !== read.profileIdNow ? ', which is not the profile the venue row names' : ''}.</p>
                <Lines items={read.lines} show={8} />
                {lines(read.preservedWarnings).map((l) => <p key={l} style={T.warn}>{l}</p>)}
                <p style={{ ...T.plain, marginTop: 8 }}>
                  {read.same ? 'Adyen holds exactly the rules the card above writes.' : read.card?.lacking?.length ? 'The card above has a row with no price, so nothing can be compared.' : `The card above would write ${plural(read.next?.rules || 0, 'rule', 'rules')}. ${read.diff ? `${read.diff.counts.removed} would go, ${read.diff.counts.added} would be added, ${read.diff.counts.kept} stay as they are.` : ''}`}
                </p>
                {read.next?.refundLine && !read.same && <p style={T.bold}>After writing: {read.next.refundLine}</p>}
              </>
            )}
            {lines(read.unseenVariants).length > 0 && (
              <p style={{ ...T.quiet, marginTop: 8 }}>Card names seen in the last 30 days that no rule names (they pay the any other card price on both sides): {read.unseenVariants.join(', ')}.</p>
            )}
            {ledger && (
              <p style={{ ...T.quiet, marginTop: 8 }}>
                Our records, last 30 days: {ledger.payments ?? 'unknown'} live payments, {ledger.withVariant ?? 'unknown'} with a card type name, {ledger.withFundingSource ?? 'unknown'} with a funding source, {ledger.withShopperInteraction ?? 'unknown'} with a channel mark.
                {' '}Recorded from the Adyen rules: {ledger.stampedFromRules ?? 'unknown'}. From the old flat charge: {ledger.stampedLegacy ?? 'unknown'}. No rule matched: {ledger.unmatched ?? 'unknown'}.
              </p>
            )}
            {read.last && (
              <p style={T.quiet}>Last payment: {when(read.last.created_at)}, {read.last.rate_category || 'no type'}, fee {read.last.commission_minor == null ? 'not recorded' : `${read.last.commission_minor}p`}, rule {read.last.fee_rule || 'the rate card (before the cutover)'}.</p>
            )}
            {read.rulesColumnsReady === false && <p style={T.warn}>One database update is waiting on ServOS: {read.migration_file}.</p>}
          </div>
        )}
      </div>

      {/* ── 2. Write these rates to Adyen ── */}
      <div style={T.panel}>
        <p style={T.title}>Write these rates to Adyen</p>
        <p style={T.quiet}>Preview first. The preview shows every rule that would change and the refund rule. Nothing is sent until you press Write.</p>
        <div style={T.row}>
          <button type="button" style={{ ...T.btn, ...disabled(writeBusy) }} disabled={!!writeBusy} onClick={doPreview}>{writeBusy === 'preview' ? 'Reading Adyen' : preview ? 'Preview again' : 'Preview'}</button>
          {preview && <button type="button" style={T.link} onClick={() => { setPreview(null); setTyped(''); }}>Not now</button>}
        </div>
        <Problem text={writeProblem?.text} detail={writeProblem?.detail} />
        {preview && (
          <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${preview.live ? 'var(--red-b, var(--red))' : 'var(--bdr2)'}`, background: preview.live ? 'var(--red-d, rgba(255,90,74,.08))' : 'transparent' }}>
            <p style={T.bold}>{p.same ? 'Nothing to write' : 'What writing will change'}</p>
            {lines(p.lines).map((l) => <p key={l} style={T.plain}>{l}</p>)}
            {preview.profileUnread && <p style={T.warn}>The rules on Adyen now could not be read, so what changes cannot be shown.</p>}
            {lines(preview.overLimit).map((l) => <p key={l} style={T.warn}>{l}</p>)}
            {lines(preview.preservedWarnings).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <p style={T.warn}>The rules on Adyen carry settings ServOS did not write. They are carried over as they are:</p>
                {lines(preview.preservedWarnings).map((l) => <p key={l} style={T.warn}>{l}</p>)}
              </div>
            )}
            {!p.same && <p style={{ ...T.bold, marginTop: 8 }}>{preview.refundLine}</p>}
            {!p.same && <Lines items={p.ruleLines} show={10} label="changes" />}
            {preview.ledgerWarning && <p style={{ ...T.warn, marginTop: 8 }}>{preview.ledgerWarning}</p>}
            <p style={{ ...T.quiet, marginTop: 8 }}>
              {preview.live ? 'This venue takes real cards. ' : 'This venue is on test cards. '}
              From the moment you write, Adyen charges these rules and new payments are recorded from them. Past payments do not change.
            </p>
            <button type="button" style={{ ...T.link, marginTop: 8 }} onClick={() => setShowSent((v) => !v)}>{showSent ? 'Hide what is sent to Adyen' : 'Show what is sent to Adyen'}</button>
            {showSent && <pre style={{ ...T.mono, whiteSpace: 'pre-wrap', margin: '8px 0 0', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(preview.requests, null, 2)}</pre>}
            {canSend && (
              <div style={T.row}>
                {needsTyped && (
                  <label style={{ display: 'grid', gap: 4 }}>
                    <span style={T.bold}>Type LIVE to confirm.</span>
                    <input style={T.input} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="LIVE" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
                  </label>
                )}
                <button type="button" style={{ ...(preview.live ? T.live : T.prim), ...disabled(writeBusy || !typedOk) }} disabled={!!writeBusy || !typedOk} onClick={doSend}>
                  {writeBusy === 'send' ? 'Writing' : 'Write these rates to Adyen'}
                </button>
              </div>
            )}
          </div>
        )}
        {written && (
          <div style={{ marginTop: 12 }}>
            <p style={T.ok}>Written. Adyen charges these rules from {when(written.ratesLiveAt)}{written.firstWrite ? ', the cutover for this venue' : ''}. {written.rules} rules{written.readBack ? ', read back from Adyen' : ', as sent (the read back failed)'}.</p>
            {written.refundLine && <p style={T.bold}>{written.refundLine}</p>}
            <p style={T.plain}>{written.pastPayments}</p>
            {written.restatementFile && <p style={T.mono}>{written.restatementFile}</p>}
            {lines(written.warnings).map((l) => <p key={l} style={T.warn}>{l}</p>)}
          </div>
        )}
      </div>

      {/* ── 3. Switch on card type data ── */}
      <div style={T.panel}>
        <p style={T.title}>Switch on card type data</p>
        <p style={T.quiet}>Asks Adyen to send the card type (credit, debit, prepaid), the channel and the store on every payment notice. A cross check: the rates match without it.</p>
        <div style={T.row}>
          <button type="button" style={{ ...T.btn, ...disabled(hookBusy) }} disabled={!!hookBusy} onClick={doHooksRead}>{hookBusy === 'read' ? 'Reading Adyen' : 'Read the webhook settings'}</button>
          <button type="button" style={{ ...T.btn, ...disabled(hookBusy) }} disabled={!!hookBusy} onClick={doCheck}>{hookBusy === 'check' ? 'Checking' : 'Check new payments'}</button>
        </div>
        <Problem text={hookProblem?.text} detail={hookProblem?.detail} />
        {check && (
          <p style={{ ...T.plain, marginTop: 8 }}>Since {when(check.since)}: {check.payments ?? 'unknown'} live payments, {check.withFundingSource ?? 'unknown'} with a card type, {check.withShopperInteraction ?? 'unknown'} with a channel mark.</p>
        )}
        {hooks && (
          <div style={{ marginTop: 10 }}>
            {!ours.length && <p style={T.warn}>No webhook on this account points at adyen-webhook. {others.length ? `${plural(others.length, 'other webhook', 'other webhooks')} found.` : 'No webhooks found.'}</p>}
            {ours.map((h) => (
              <div key={h.id} style={{ marginTop: 8 }}>
                <p style={T.plain}>{h.active ? 'Active' : 'Not active'} webhook <span style={T.mono}>{h.id}</span></p>
                <p style={T.mono}>{h.url}</p>
                {Object.keys(h.properties || {}).length
                  ? <p style={T.quiet}>Settings as Adyen returns them: {Object.entries(h.properties).map(([k, v]) => `${k} ${v === true ? 'on' : v === false ? 'off' : String(v)}`).join(', ')}.</p>
                  : <p style={T.quiet}>Adyen returned no setting keys for this webhook.</p>}
                {(h.candidates || []).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {h.candidates.map((c) => (
                      <label key={c.key} style={{ ...T.plain, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="checkbox" checked={!!picked[`${h.id}|${c.key}`]} onChange={(e) => setPicked((prev) => ({ ...prev, [`${h.id}|${c.key}`]: e.target.checked }))} />
                        Switch on {c.name} ({c.key})
                      </label>
                    ))}
                    <div style={T.row}>
                      {live === true && (
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={T.bold}>Type ON to confirm.</span>
                          <input style={T.input} value={onTyped} onChange={(e) => setOnTyped(e.target.value)} placeholder="ON" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
                        </label>
                      )}
                      <button type="button" style={{ ...(live === true ? T.live : T.prim), ...disabled(hookBusy || !onOk) }} disabled={!!hookBusy || !onOk} onClick={() => doSwitch(h)}>{hookBusy === 'write' ? 'Switching on' : 'Switch on'}</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {ours.length > 0 && !candidateHooks.length && (
              <div style={{ marginTop: 8 }}>
                <p style={T.plain}>Adyen shows no setting here that can be switched on from ServOS. Do it in the Customer Area:</p>
                <ol style={T.list}>{lines(hooks.clicks).map((c) => <li key={c}>{c}</li>)}</ol>
                <p style={T.quiet}>Then press Check new payments after the next card payment.</p>
              </div>
            )}
            {switched && <p style={{ ...T.ok, marginTop: 8 }}>Switched on: {lines(switched.written).join(', ')}. Press Check new payments after the next card payment.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
