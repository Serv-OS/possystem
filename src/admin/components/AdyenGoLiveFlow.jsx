// src/admin/components/AdyenGoLiveFlow.jsx
//
// ServOS admin portal (?mode=admin): GET THIS VENUE TAKING CARDS, the guided
// five step flow that replaced the dense "Link to Adyen" panel on 8 Sep 2026.
//
// OWNER FEEDBACK (8 Sep 2026, verbatim): "we need this to be easier and better
// there is far too many words and too small we need a flow that supports
// someone doing this". So:
//   1. Five numbered steps down the page, one open at a time, the first that
//      is not done. A done step collapses to its title, a tick and one line.
//   2. Inside the open step: ONE sentence, then ONE primary button. Anything
//      else is a small secondary link.
//   3. Body text 15px, titles 18px, line height 1.5, one column, 720px wide.
//   4. Plain words, with the Adyen word in small grey brackets on first use:
//      Adyen business account (account holder), Where the money lands
//      (balance account), Registered company (legal entity), Payments
//      location (store), Card machine (terminal).
//   5. Ids are secondary: small, monospace, grey, with a copy button. Never
//      in a sentence.
//   6. An error is one plain sentence: what happened and what to do next. The
//      raw answer hides behind a small "Show detail".
//   7. A capability Adyen has not allowed reads "Adyen has not approved this
//      yet" with its name in grey, never the word Blocked on its own.
//
// The screen DECIDES NOTHING. One call, golive_state, answers the five steps
// (state, detail, action, hint) and everything they need; the flow draws them
// and reloads after every action so the steps move on their own. The wording
// and the chips come from src/lib/payments/adyenAdminRows.js (pure, tested).
//
// The server calls, all super_admin fenced in adyen-terminal-admin:
//   golive_state                     read the venue (every load, every reload)
//   adyen_merchants                  the accounts the credential can see
//   adyen_lookup                     read again, to build the go live confirm
//   adyen_link                       ONE write of the ids + the flip to live
//   adyen_create_store_by_reference  make the payments location
//   register_origins                 the ServOS web addresses
//   register_apple_pay_domains       the venue's storefront for Apple Pay
//
// SAFETY, unchanged from the panel this replaces: going live ALWAYS asks, and
// the confirm says what is kept and what comes back (goLiveConfirmText). The
// fn's own 409 needs_relink is a second confirm (relinkConfirmText).
//
// Props:
//   location    the platform locations row (id, name, address)
//   venueCode   ops locations.venue_code, for the empty state line
//   callAdmin   (action, payload) => the adyen-terminal-admin answer; MUST
//               throw on a non-2xx with err.status and err.data set
//   onChanged   fired after anything changed the venue
//   refreshKey  bump it to make the flow read again

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  goliveFlowView, capabilityNotices, mismatchView, plainFailure,
  goLiveConfirmText, relinkConfirmText, merchantPicker, candidateLabel,
} from '../../lib/payments/adyenAdminRows';

const CHIP = {
  ok: { bg: 'var(--grn-d, rgba(21,194,106,.14))', fg: 'var(--grn, #15C26A)', bd: 'var(--grn-b, var(--grn))' },
  idle: { bg: 'var(--bg3, rgba(127,127,127,.12))', fg: 'var(--t3)', bd: 'var(--bdr2)' },
  warn: { bg: 'var(--orn-d, rgba(230,160,60,.14))', fg: 'var(--orn, #e8a020)', bd: 'var(--orn-b, var(--bdr2))' },
  bad: { bg: 'var(--red-d, rgba(255,90,74,.12))', fg: 'var(--red)', bd: 'var(--red-b, var(--red))' },
};

const S = {
  wrap: { marginTop: 14, maxWidth: 720 },
  card: { borderRadius: 14, background: 'var(--bg2)', border: '1px solid var(--bdr2)', overflow: 'hidden' },
  head: { padding: '20px 22px 18px' },
  h1: { fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: 0, lineHeight: 1.4, letterSpacing: '-.01em' },
  lede: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', margin: '8px 0 0' },
  progress: { fontSize: 15, fontWeight: 700, color: 'var(--t2)', margin: '16px 0 8px' },
  bar: { height: 6, borderRadius: 999, background: 'var(--bdr2)', overflow: 'hidden' },
  rowBtn: {
    display: 'flex', alignItems: 'center', gap: 16, width: '100%', boxSizing: 'border-box',
    padding: '18px 22px', background: 'transparent', border: 0, borderTop: '1px solid var(--bdr)',
    font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'inherit',
  },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.4 },
  found: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', marginTop: 4 },
  body: { padding: '0 22px 24px 74px' },
  say: { fontSize: 15, lineHeight: 1.5, color: 'var(--t1)', margin: '0 0 12px', maxWidth: 60 * 9 },
  quiet: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', margin: '0 0 12px' },
  brack: { fontSize: 13, color: 'var(--t3)', fontWeight: 400 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  idRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', flexWrap: 'wrap' },
  idLabel: { fontSize: 13, color: 'var(--t3)', minWidth: 150 },
  idValue: { fontSize: 13, color: 'var(--t3)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', wordBreak: 'break-all' },
  copy: { background: 'transparent', border: '1px solid var(--bdr2)', borderRadius: 6, color: 'var(--t3)', fontSize: 12, padding: '2px 8px', cursor: 'pointer', font: 'inherit', fontFamily: 'inherit', lineHeight: 1.6 },
  prim: {
    minHeight: 46, padding: '12px 22px', borderRadius: 10, border: '1px solid var(--acc)',
    background: 'var(--acc)', color: '#0b0c10', fontSize: 15, fontWeight: 800, cursor: 'pointer',
    font: 'inherit', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4,
  },
  live: { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' },
  link: {
    background: 'transparent', border: 0, padding: 0, color: 'var(--t2)', fontSize: 14,
    textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontFamily: 'inherit',
  },
  small: {
    minHeight: 34, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr2)',
    background: 'transparent', color: 'var(--t2)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    font: 'inherit', fontFamily: 'inherit',
  },
  input: {
    boxSizing: 'border-box', height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid var(--bdr2)',
    background: 'var(--bg1)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', width: '100%',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  fieldLabel: { fontSize: 13, color: 'var(--t3)' },
  note: { fontSize: 15, lineHeight: 1.5, borderRadius: 10, padding: '12px 14px', margin: '14px 0 0' },
};

// The Adyen word, in small grey brackets, on FIRST use only. makeTerm() is
// called once per render pass, so the brackets appear at the top of the page
// and the plain words carry the rest.
const TERMS = {
  holder: ['Adyen business account', 'account holder'],
  money: ['Where the money lands', 'balance account'],
  legal: ['Registered company', 'legal entity'],
  store: ['Payments location', 'store'],
  reader: ['Card machine', 'terminal'],
};
function makeTerm() {
  const seen = new Set();
  return function term(key, { lower = false } = {}) {
    const [plain, adyen] = TERMS[key];
    const text = lower ? plain.charAt(0).toLowerCase() + plain.slice(1) : plain;
    if (seen.has(key)) return <>{text}</>;
    seen.add(key);
    return <>{text} <span style={S.brack}>({adyen})</span></>;
  };
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
        border: '2px solid currentColor', borderTopColor: 'transparent',
        animation: 'agfSpin .7s linear infinite', marginRight: 8, verticalAlign: '-2px',
      }}
    />
  );
}

// One primary button. Only this button spins, and only this button is disabled
// while it works.
function Primary({ busy, disabled, live, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!busy || !!disabled}
      style={{ ...S.prim, ...(live ? S.live : null), opacity: busy || disabled ? 0.6 : 1, cursor: busy || disabled ? 'default' : 'pointer' }}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

// An id: small, monospace, grey, with a copy button. Never inside a sentence.
function IdLine({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(value)); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked: the id is on screen to read */ }
  };
  return (
    <div style={S.idRow}>
      <span style={S.idLabel}>{label}</span>
      <span style={S.idValue}>{value}</span>
      <button type="button" style={S.copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// One plain sentence, with the raw answer behind a small toggle.
function Problem({ problem, tone = 'bad' }) {
  const [open, setOpen] = useState(false);
  if (!problem?.text) return null;
  const c = CHIP[tone] || CHIP.bad;
  return (
    <div style={{ ...S.note, background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}>
      <div>{problem.text}</div>
      {problem.detail && (
        <>
          <button type="button" style={{ ...S.link, color: c.fg, marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide detail' : 'Show detail'}
          </button>
          {open && <div style={{ ...S.idValue, marginTop: 8, color: c.fg, whiteSpace: 'pre-wrap' }}>{problem.detail}</div>}
        </>
      )}
    </div>
  );
}

// A free text address ("9a New Street, Huddersfield, HD3 4LN") split for the
// create form. The admin corrects it.
function splitAddress(text) {
  const parts = String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  return {
    line1: parts.length >= 3 ? parts.slice(0, -2).join(', ') : (parts[0] || ''),
    city: parts.length >= 3 ? parts[parts.length - 2] : (parts[1] || ''),
    postal_code: parts.length >= 2 ? parts[parts.length - 1] : '',
  };
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// What was being done, for the one plain error sentence.
function whatFailed(key) {
  if (key === 'create') return 'The payments location could not be made';
  if (key === 'golive') return 'Live payments could not be turned on';
  if (key === 'origins') return 'The web addresses could not be added';
  if (key === 'merchant') return 'That Adyen account could not be read';
  return 'The venue could not be read';
}

export default function AdyenGoLiveFlow({ location, venueCode, callAdmin, onChanged, refreshKey = 0 }) {
  const name = location?.name || 'this venue';
  // Every read and write carries the same identity choices: the merchant
  // account the admin picked (the live mismatch), a store or business account
  // id pasted or picked from a list.
  const [pick, setPick] = useState({});
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadProblem, setLoadProblem] = useState(null);
  const [busy, setBusy] = useState('');
  const [openId, setOpenId] = useState(null);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState('');
  const [pasted, setPasted] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pickedStore, setPickedStore] = useState('');
  const [merchants, setMerchants] = useState(null);
  const [merchantChoice, setMerchantChoice] = useState('');
  const [form, setForm] = useState(() => ({ ...splitAddress(location?.address), phone: '' }));
  // The create was refused because the venue's row holds no business line:
  // the link writes it, and the link is the go live step. Offered here as a
  // small secondary so the live case (a business account with no payments
  // location) is not a dead end.
  const [linkFirst, setLinkFirst] = useState(false);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const load = useCallback(async (nextPick) => {
    const payload = nextPick === undefined ? pickRef.current : nextPick;
    if (nextPick !== undefined) setPick(nextPick);
    setLoading(true);
    try {
      const r = await callAdmin('golive_state', { ...payload });
      if (r?.ok === false) throw new Error(r.error || 'the venue could not be read');
      setState(r);
      setLoadProblem(null);
    } catch (e) {
      // A failed RE-read keeps the last answer on screen with a warning: the
      // five steps are still the truth as of a moment ago. Only a first load
      // has nothing to show.
      setLoadProblem(plainFailure(e, 'The venue could not be read'));
    }
    setLoading(false);
  }, [callAdmin]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const view = useMemo(() => goliveFlowView(state, openId), [state, openId]);
  const open = view.steps.find((x) => x.open) || null;
  const target = str(state?.target) === 'test' ? 'test' : 'live';
  const region = str(state?.venue?.region) || 'UK';
  const reference = str(state?.reference) || str(venueCode);
  const caps = capabilityNotices(state?.capabilities);
  const mismatch = mismatchView(state?.merchantMismatch);
  const readers = Array.isArray(state?.readers) ? state.readers : [];
  const candidates = Array.isArray(state?.candidates) ? state.candidates : [];

  // The accounts the credential can see, read once when the mismatch step is
  // open (it is the step that offers the picker).
  const wantMerchants = !!mismatch && open?.id === 'payments_location';
  useEffect(() => {
    if (!wantMerchants || merchants !== null) return;
    let live = true;
    (async () => {
      try {
        const r = await callAdmin('adyen_merchants', {});
        if (live) setMerchants(r);
      } catch (e) {
        if (live) setMerchants({ error: plainFailure(e, 'The Adyen accounts could not be listed') });
      }
    })();
    return () => { live = false; };
  }, [wantMerchants, merchants, callAdmin]);

  const picker = merchants && !merchants.error ? merchantPicker(merchants, target) : null;
  // Adyen refuses a LIVE payments location without the real address and phone
  // number, so the button waits for them instead of a round trip that fails.
  const addressDone = !!(form.line1.trim() && form.city.trim() && form.postal_code.trim() && form.phone.trim());
  const canCreate = !!reference && (target !== 'live' || addressDone);

  // Every action: spin on its own button, then read the venue again so the
  // steps move by themselves.
  const act = async (key, work) => {
    setBusy(key); setProblem(null); setNotice('');
    try {
      const done = await work();
      if (done?.notice) setNotice(done.notice);
      if (done?.changed) onChanged?.();
      if (done?.stop) { setBusy(''); return; }
      await load();
    } catch (e) {
      setProblem(plainFailure(e, whatFailed(key)));
    }
    setBusy('');
  };

  const pastedLooksRight = /^(AH|ST)/i.test(pasted.trim());

  const applyPastedId = () => {
    const v = pasted.trim().toUpperCase();
    if (!pastedLooksRight) return;
    const next = { ...pick };
    if (v.startsWith('AH')) next.accountHolderId = v;
    else next.storeId = v;
    act('paste', async () => {
      setPasteOpen(false); setPasted('');
      await load(next);
      return { stop: true };
    });
  };

  const applyCandidate = () => {
    if (!pickedStore) return;
    act('candidate', async () => {
      await load({ ...pick, storeId: pickedStore });
      return { stop: true };
    });
  };

  const applyMerchant = () => {
    if (!merchantChoice) return;
    act('merchant', async () => {
      await load({ ...pick, merchantAccount: merchantChoice });
      return { stop: true, notice: `Reading ${merchantChoice} for this venue now.` };
    });
  };

  const openAdyen = () => {
    window.open(target === 'live' ? 'https://ca-live.adyen.com' : 'https://ca-test.adyen.com', '_blank', 'noopener');
  };

  const createStore = () => act('create', async () => {
    setLinkFirst(false);
    const r = await callAdmin('adyen_create_store_by_reference', {
      ...pick,
      ...(reference ? { reference } : {}),
      address: { line1: form.line1.trim(), city: form.city.trim(), postal_code: form.postal_code.trim() },
      phone: form.phone.trim(),
      ...(target === 'test' ? { environment: 'test' } : {}),
    });
    if (r?.ok === false) {
      const detail = r.error === 'scope_missing' ? (r.detail || 'The Adyen key lacks the Management Stores role.') : str(r.error);
      if (/business line/i.test(str(r.hint)) || /business line/i.test(detail)) {
        setLinkFirst(true);
        setProblem({ text: 'Adyen wants the venue’s business line first. Turn on live payments, then make the payments location.', detail: [detail, str(r.hint)].filter(Boolean).join(' ') || null });
        return { stop: true };
      }
      setProblem(plainFailure({ data: { error: detail } }, 'The payments location could not be made'));
      return { stop: true };
    }
    const made = r.existing ? `Adyen already had the payments location ${r.storeId}.` : `Payments location ${r.storeId} is ready.`;
    const money = r.balanceAccountLink?.ok ? ' The money is joined to it.' : '';
    return { notice: `${made}${money}`, changed: true };
  });

  // GOING LIVE ALWAYS ASKS. The confirm is built from a fresh read, so it says
  // what is kept and what comes back (goLiveConfirmText). The fn's own 409
  // needs_relink is the second ask, and the retry stays on the same button.
  const goLiveWork = async (relink, asked) => {
    if (!asked) {
      const look = await callAdmin('adyen_lookup', { ...pickRef.current });
      if (look?.ok === false) throw new Error(look.error || 'the venue could not be read');
      if (!window.confirm(goLiveConfirmText(look, name))) return { stop: true };
    }
    let r;
    try {
      r = await callAdmin('adyen_link', { ...pickRef.current, ...(relink ? { relink: true } : {}) });
    } catch (e) {
      if (e?.data?.needs_relink && !relink) {
        if (!window.confirm(relinkConfirmText(e.data, name))) return { stop: true };
        return goLiveWork(true, true);
      }
      throw e;
    }
    if (r?.ok === false) throw new Error(r.error || 'the link did not go through');
    const where = r.unchanged ? `${name} was already linked.`
      : str(r.environment) === 'live' ? `${name} takes real cards now.`
      : `${name} is linked on test.`;
    const needs = r.storeNeeded ? ' It still needs a payments location.' : '';
    return { notice: `${where}${needs}`, changed: true };
  };
  const goLive = () => act('golive', () => goLiveWork(false, false));

  const addOrigins = () => act('origins', async () => {
    const one = async (action) => {
      try { return await callAdmin(action, {}); }
      catch (e) { return { ok: false, error: e?.data?.error || e?.message || String(e) }; }
    };
    const o = await one('register_origins');
    const a = await one('register_apple_pay_domains');
    const bad = [o, a].filter((x) => x?.ok === false);
    if (bad.length) {
      setProblem({
        text: 'Adyen would not take all of the web addresses. Try again, and open Show detail to see what it said.',
        detail: bad.map((x) => str(x.error) || 'no reason given').join('\n'),
      });
      return { changed: true };
    }
    const added = (Array.isArray(o.added) ? o.added.length : 0) + (Array.isArray(a.added) ? a.added.length : 0);
    return { notice: added ? `${added} web address${added === 1 ? '' : 'es'} added.` : 'The web addresses were already in place.', changed: true };
  });

  if (loading && !state) {
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, ...S.head }}>
          <h3 style={S.h1}>Get {name} taking cards</h3>
          <p style={S.lede}>Reading the venue at Adyen.</p>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, ...S.head }}>
          <h3 style={S.h1}>Get {name} taking cards</h3>
          <Problem problem={loadProblem} />
          <div style={{ marginTop: 14 }}>
            <Primary busy={busy === 'reload'} onClick={() => act('reload', async () => ({}))}>Try again</Primary>
          </div>
        </div>
      </div>
    );
  }

  const term = makeTerm();

  return (
    <div style={S.wrap}>
      <style>{'@keyframes agfSpin{to{transform:rotate(360deg)}}'}</style>
      <div style={S.card}>
        <div style={S.head}>
          <h3 style={S.h1}>Get {name} taking cards</h3>
          <p style={S.lede}>Five steps. Do the open one, the rest follow.</p>
          <p style={{ ...S.lede, marginTop: 4 }}>
            {reference ? <>Looking for <span style={S.mono}>{reference}</span> on the {region} {target} account.</> : <>Looking on the {region} {target} account.</>}
          </p>
          <div style={S.progress}>{view.progressLabel}</div>
          <div style={S.bar}><div style={{ height: '100%', width: `${view.progressPct}%`, background: 'var(--grn, #15C26A)', transition: 'width .2s' }} /></div>
        </div>

        {view.steps.map((step) => {
          const tone = CHIP[step.chip.tone] || CHIP.idle;
          // The venue has no code, so there is nothing to search Adyen for:
          // pasting the id is the way forward, and it takes the one primary.
          const noCode = step.action === 'set_venue_code';
          // The server's own line for a capability Adyen refuses names it in
          // Adyen's words ("Adyen blocks sendToTransferInstrument"). The rule
          // here is plainer: "Adyen has not approved this yet" with the name
          // in grey, so the capability rows say it instead of the detail.
          const capsSpeak = step.id === 'business_account' && caps.length > 0;
          // Same for the two accounts: the mismatch block says it once, in
          // plain words, with the two names as ids and a picker under them.
          const mismatchSpeaks = step.id === 'payments_location' && !!mismatch;
          return (
            <div key={step.id}>
              <button
                type="button"
                onClick={() => setOpenId(step.id)}
                aria-expanded={step.open}
                style={S.rowBtn}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flexShrink: 0, width: 36, height: 36, borderRadius: '50%', display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800,
                    background: step.done ? CHIP.ok.bg : step.open ? 'var(--acc)' : 'var(--bg3, rgba(127,127,127,.12))',
                    color: step.done ? CHIP.ok.fg : step.open ? '#0b0c10' : 'var(--t3)',
                    border: `1px solid ${step.done ? CHIP.ok.bd : step.open ? 'var(--acc)' : 'var(--bdr2)'}`,
                  }}
                >
                  {step.done ? '✓' : step.number}
                </span>
                <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <span style={{ ...S.title, display: 'block' }}>{step.title}</span>
                  {step.done && step.detail && !step.open && <span style={{ ...S.found, display: 'block' }}>{step.detail}</span>}
                </span>
                <span
                  style={{
                    flexShrink: 0, fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                    background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}`,
                  }}
                >
                  {step.chip.label}
                </span>
              </button>

              {step.open && (
                <div style={S.body}>
                  {step.detail && !capsSpeak && !mismatchSpeaks && <p style={S.say}>{step.detail}</p>}
                  {capsSpeak && (
                    <div style={{ margin: '0 0 12px' }}>
                      {caps.map((c) => (
                        <div key={c.name} style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 4, color: c.tone === 'bad' ? 'var(--red)' : 'var(--orn, #e8a020)' }}>
                          {c.text} <span style={S.brack}>({c.label})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {step.hint && !mismatchSpeaks && <p style={S.quiet}>{step.hint}</p>}

                  {/* ── 1. find the venue ── */}
                  {step.id === 'find_venue' && (
                    <>
                      {/* the venue has no code, so there is nothing to search for */}
                      {state.needsBalancePlatform && (
                        <p style={S.quiet}>
                          Adyen has no way to search for a venue by its code on the money side, so the id has to be pasted here, or the
                          balance platform id put on the server as <span style={S.mono}>{str(state.balancePlatformSecret) || 'the balance platform secret'}</span>.
                        </p>
                      )}
                      {/* No venue code: pasting the id IS the way forward, so
                          the box is open and it carries the one primary. */}
                      {noCode ? (
                        <div style={{ maxWidth: 460 }}>
                          <label style={S.field}>
                            <span style={S.fieldLabel}>Paste the id from Adyen. It starts with AH or ST.</span>
                            <input
                              style={{ ...S.input, ...S.mono }}
                              value={pasted}
                              placeholder="AH32BZP22322CJ5PXF2BD5FTR"
                              onChange={(e) => setPasted(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') applyPastedId(); }}
                              spellCheck={false}
                              autoComplete="off"
                            />
                          </label>
                          <div style={{ marginTop: 14 }}>
                            <Primary busy={busy === 'paste'} disabled={!pastedLooksRight} onClick={applyPastedId}>Use this id</Primary>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Primary busy={busy === 'look'} onClick={() => act('look', async () => ({}))}>Look again</Primary>
                            {!pasteOpen && <button type="button" style={S.link} onClick={() => setPasteOpen(true)}>I have the Adyen id</button>}
                          </div>
                          {pasteOpen && (
                            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 14, maxWidth: 460 }}>
                              <label style={{ ...S.field, flex: '1 1 240px' }}>
                                <span style={S.fieldLabel}>Paste the id from Adyen. It starts with AH or ST.</span>
                                <input
                                  style={{ ...S.input, ...S.mono }}
                                  value={pasted}
                                  placeholder="AH32BZP22322CJ5PXF2BD5FTR"
                                  onChange={(e) => setPasted(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') applyPastedId(); }}
                                  spellCheck={false}
                                  autoComplete="off"
                                />
                              </label>
                              <button type="button" style={{ ...S.small, opacity: pastedLooksRight ? 1 : 0.6 }} disabled={!pastedLooksRight || busy === 'paste'} onClick={applyPastedId}>
                                {busy === 'paste' ? <Spinner /> : null}Use it
                              </button>
                            </div>
                          )}
                          {candidates.length > 0 && (
                            <div style={{ marginTop: 18, maxWidth: 520 }}>
                              <label style={S.field}>
                                <span style={S.fieldLabel}>Or pick the venue from the {candidates.length} places Adyen holds on this account</span>
                                <select style={S.input} value={pickedStore} onChange={(e) => setPickedStore(e.target.value)}>
                                  <option value="">Pick one</option>
                                  {candidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
                                </select>
                              </label>
                              <button type="button" style={{ ...S.link, marginTop: 10, opacity: pickedStore ? 1 : 0.6 }} disabled={!pickedStore || busy === 'candidate'} onClick={applyCandidate}>
                                {busy === 'candidate' ? 'Reading it' : 'Use the one I picked'}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      {(state.store?.id || state.holder?.id) && (
                        <div style={{ marginTop: 16 }}>
                          <IdLine label="Payments location" value={state.store?.id} />
                          <IdLine label="Business account" value={state.holder?.id} />
                        </div>
                      )}
                    </>
                  )}

                  {/* ── 2. the Adyen business account ── */}
                  {step.id === 'business_account' && (
                    <>
                      {(step.action === 'open_adyen' || step.action === 'send_onboarding') && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary onClick={openAdyen}>Open Adyen</Primary>
                          <button type="button" style={S.link} onClick={() => act('look2', async () => ({}))}>{busy === 'look2' ? 'Checking' : 'Check again'}</button>
                        </div>
                      )}
                      {step.action === 'find_venue' && (
                        <Primary busy={busy === 'look'} onClick={() => act('look', async () => ({}))}>Look again</Primary>
                      )}
                      <div style={{ marginTop: 16 }}>
                        <IdLine label={<>{term('holder')}</>} value={state.holder?.id} />
                        <IdLine label={<>{term('money')}</>} value={state.balanceAccount?.id} />
                        <IdLine label={<>{term('legal')}</>} value={state.legalEntity?.id} />
                      </div>
                    </>
                  )}

                  {/* ── 3. the payments location ── */}
                  {step.id === 'payments_location' && (
                    <>
                      {mismatch && (
                        <div style={{ marginBottom: 18 }}>
                          <p style={S.say}>{mismatch.text}</p>
                          <IdLine label="Where the venue is" value={mismatch.theirs} />
                          <IdLine label="What we are set to use" value={mismatch.ours} />
                          {picker && picker.options.length > 0 && (
                            <div style={{ marginTop: 14, maxWidth: 520 }}>
                              <label style={S.field}>
                                <span style={S.fieldLabel}>Pick the right account for this venue</span>
                                <select style={S.input} value={merchantChoice} onChange={(e) => setMerchantChoice(e.target.value)}>
                                  <option value="">Pick one</option>
                                  {picker.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </label>
                              <div style={{ marginTop: 14 }}>
                                <Primary busy={busy === 'merchant'} disabled={!merchantChoice} onClick={applyMerchant}>Use this account</Primary>
                              </div>
                            </div>
                          )}
                          {merchants === null && <p style={S.quiet}>Reading the Adyen accounts we can see.</p>}
                          {merchants?.error && <Problem problem={merchants.error} tone="warn" />}
                          {picker && picker.options.length === 0 && (
                            <p style={S.quiet}>
                              The accounts could not be listed{picker.error ? `: ${picker.error}` : ''}. Point{' '}
                              <span style={S.mono}>{picker.secret || 'the merchant account secret'}</span> at {mismatch.theirs || 'the right account'} on the server instead.
                            </p>
                          )}
                        </div>
                      )}

                      {!mismatch && step.action === 'create_store' && (
                        <>
                          {target === 'live' && !addressDone && <p style={S.quiet}>Adyen needs all four of these for a live venue.</p>}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, maxWidth: 620, margin: '0 0 18px' }}>
                            {[
                              ['line1', 'Street'],
                              ['city', 'Town or city'],
                              ['postal_code', 'Postcode'],
                              ['phone', 'Phone number'],
                            ].map(([key, label]) => (
                              <label key={key} style={S.field}>
                                <span style={S.fieldLabel}>{label}</span>
                                <input style={S.input} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
                              </label>
                            ))}
                          </div>
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Primary busy={busy === 'create'} disabled={!canCreate} onClick={createStore}>Make the payments location</Primary>
                            {linkFirst && (
                              <button type="button" style={S.link} onClick={goLive}>{busy === 'golive' ? 'Working' : 'Turn on live payments first'}</button>
                            )}
                          </div>
                        </>
                      )}

                      {!mismatch && step.action === 'open_adyen' && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary onClick={openAdyen}>Open Adyen</Primary>
                          <button type="button" style={S.link} onClick={() => act('look3', async () => ({}))}>{busy === 'look3' ? 'Checking' : 'Check again'}</button>
                        </div>
                      )}

                      {!mismatch && (
                        <div style={{ marginTop: 16 }}>
                          <IdLine label={<>{term('store')}</>} value={state.store?.id} />
                          <IdLine label="Adyen account" value={str(state.store?.merchantId) || str(state.merchantConfigured)} />
                        </div>
                      )}
                    </>
                  )}

                  {/* ── 4. turn on live payments ── */}
                  {step.id === 'go_live' && (
                    <>
                      {step.action === 'go_live' && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary busy={busy === 'golive'} live onClick={goLive}>Turn on live payments</Primary>
                          <span style={S.brack}>You are asked to confirm first.</span>
                        </div>
                      )}
                      {step.action === 'register_origins' && (
                        <Primary busy={busy === 'origins'} onClick={addOrigins}>Add the web addresses</Primary>
                      )}
                    </>
                  )}

                  {/* ── 5. card readers ── */}
                  {step.id === 'readers' && (
                    <>
                      <p style={S.quiet}>
                        A {term('reader', { lower: true })} is added and put on a till in the venue&rsquo;s own Back Office, under Card payments.
                      </p>
                      {readers.length > 0 && (
                        <div style={{ margin: '0 0 16px' }}>
                          {readers.map((r) => (
                            <div key={r.poiid} style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--t1)' }}>
                              {str(r.label) || str(r.serial) || str(r.poiid)}
                              <span style={S.brack}> {r.bound ? 'on a till' : 'not on a till yet'}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <Primary busy={busy === 'readers'} onClick={() => act('readers', async () => ({}))}>Check again</Primary>
                      {readers.length > 0 && (
                        <div style={{ marginTop: 16 }}>
                          {readers.map((r) => <IdLine key={r.poiid} label={str(r.label) || 'Card machine'} value={r.poiid} />)}
                        </div>
                      )}
                    </>
                  )}

                  {notice && (
                    <div style={{ ...S.note, background: CHIP.ok.bg, border: `1px solid ${CHIP.ok.bd}`, color: CHIP.ok.fg }}>{notice}</div>
                  )}
                  <Problem problem={problem} />
                  {loadProblem && <Problem problem={loadProblem} tone="warn" />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
