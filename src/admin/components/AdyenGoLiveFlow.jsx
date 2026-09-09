// src/admin/components/AdyenGoLiveFlow.jsx
//
// ServOS admin portal (?mode=admin): GET THIS VENUE TAKING CARDS, the guided
// five step flow that replaced the dense "Link to Adyen" panel on 8 Sep 2026.
//
// OWNER FEEDBACK (8 Sep 2026, verbatim): "we need this to be easier and better
// there is far too many words and too small we need a flow that supports
// someone doing this". So:
//   1. Five numbered steps down the page, one open at a time. A done step
//      collapses to its title, a tick and one line.
//   2. Inside the open step: ONE sentence, then ONE primary button. Anything
//      else is a small secondary link.
//   3. Body text 15px, titles 18px, line height 1.5, one column, 720px wide,
//      and every run of body copy capped at 46 characters wide so no sentence
//      wraps onto a third line. NOTHING in body copy is under 15px.
//      NEVER put the CSS shorthand `font` after `fontSize` in a style object:
//      React writes the keys in order and `font: inherit` resets the size and
//      the weight it was meant to keep (it silently shrank every primary
//      button to 14px regular, 8 Sep 2026).
//   4. Plain words, with the Adyen word in small grey brackets on first use:
//      Adyen business account (account holder), Where the money lands
//      (balance account), Registered company (legal entity), Payments
//      location (store), Card machine (terminal).
//   5. Ids are secondary: small, monospace, grey, with a copy button. Never
//      in a sentence.
//   6. An error is one plain sentence: what happened and what to do next. The
//      raw answer hides behind a small "Show detail". That includes the ones
//      golive_state answers 200 with (errors, notes, readers_error): a refusal
//      Adyen gave us must never look like "nothing found".
//   7. A capability Adyen has not allowed reads "Adyen has not approved this
//      yet" with its name in grey, never the word Blocked on its own.
//   8. No native dialog decides anything. Going live is an IN PAGE panel with
//      one line per consequence and the typed word LIVE, at the same size as
//      the rest of the screen.
//
// The screen DECIDES NOTHING. One call, golive_state, answers the five steps
// (state, detail, action, hint) and everything they need; the flow draws them
// and reloads after every action so the steps move on their own. The wording
// and the chips come from src/lib/payments/adyenAdminRows.js (pure, tested).
//
// The server calls, all super_admin fenced in adyen-terminal-admin:
//   golive_state                     read the venue (every load, every reload)
//   adyen_merchants                  the accounts the credential can see
//   adyen_lookup                     read again, to build the go live panel
//   adyen_link                       ONE write of the ids + the flip to live
//   adyen_create_store_by_reference  make the payments location
//   register_origins                 the ServOS web addresses
//   register_apple_pay_domains       the venue's storefront for Apple Pay
//
// SAFETY: going live ALWAYS asks, and the ask says what is kept and what comes
// back (goLiveConfirmLines) AND makes an admin type LIVE, the gate that used
// to live on the environment switch in AdyenEnvironmentControls. That switch
// now only brings a live venue back to test, so this panel is the only way a
// venue starts charging real cards. The fn's own 409 needs_relink is a second
// panel (relinkConfirmLines).
//
// COST: golive_state runs on mount and after every action, so it does NOT
// sweep every Adyen account by itself (that is 70+ calls). "Search every
// Adyen account" on step 1 asks for the sweep, and the answer is remembered
// for the rest of the session.
//
// ONE PASTE PER ADYEN ACCOUNT, NOT PER VENUE (8 Sep 2026): Adyen has no lookup
// by reference on the money side, so the FIRST venue on an account has its
// Adyen id pasted once. The server keeps the balance platform id behind that
// read, and from then on it finds venues by their reference on their own. Step
// 1 draws whichever of the two it is in, from referenceSearchView:
//   nothing known yet   the paste box is open and carries the one primary,
//                       under the plain line saying it is a one off
//   known               "Look again" is the primary and the paste box drops to
//                       the small "I have the Adyen id" secondary under it
//   found by reference  one line saying so, so the admin sees it working
//
// Props:
//   location    the platform locations row (id, name, address)
//   venueCode   ops locations.venue_code, for the empty state line
//   callAdmin   (action, payload) => the adyen-terminal-admin answer; MUST
//               throw on a non-2xx with err.status and err.data set
//   wallets     adyen-checkout `status` (wallets: true) probe for this venue:
//               { applepay, googlepay, offered[], error }. null = not read.
//               Step 4 says it out loud, because "the owner asked why Apple
//               Pay did not load" was previously unanswerable anywhere in the
//               product: the checkout falls back to a card-only form in
//               silence, and a scheme-only Adyen answer did not even warn.
//   onChanged   fired after anything changed the venue
//   refreshKey  bump it to make the flow read again

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  goliveFlowView, capabilityNotices, mismatchView, plainFailure, referenceSearchView,
  goLiveConfirmLines, relinkConfirmLines, merchantPicker, candidateLabel,
} from '../../lib/payments/adyenAdminRows';

const CHIP = {
  ok: { bg: 'var(--grn-d, rgba(21,194,106,.14))', fg: 'var(--grn, #15C26A)', bd: 'var(--grn-b, var(--grn))' },
  idle: { bg: 'var(--bg3, rgba(127,127,127,.12))', fg: 'var(--t3)', bd: 'var(--bdr2)' },
  warn: { bg: 'var(--orn-d, rgba(230,160,60,.14))', fg: 'var(--orn, #e8a020)', bd: 'var(--orn-b, var(--bdr2))' },
  bad: { bg: 'var(--red-d, rgba(255,90,74,.12))', fg: 'var(--red)', bd: 'var(--red-b, var(--red))' },
};

// One measure for every run of body copy, in characters so it follows the
// font rather than a guess at pixels per character.
const MEASURE = '46ch';

const S = {
  wrap: { marginTop: 14, maxWidth: 720 },
  card: { borderRadius: 14, background: 'var(--bg2)', border: '1px solid var(--bdr2)', overflow: 'hidden' },
  head: { padding: '20px 22px 18px' },
  h1: { fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: 0, lineHeight: 1.4, letterSpacing: '-.01em' },
  lede: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', margin: '8px 0 0', maxWidth: MEASURE },
  progress: { fontSize: 15, fontWeight: 700, color: 'var(--t2)', margin: '16px 0 8px' },
  bar: { height: 6, borderRadius: 999, background: 'var(--bdr2)', overflow: 'hidden' },
  rowBtn: {
    font: 'inherit',
    display: 'flex', alignItems: 'center', gap: 16, width: '100%', boxSizing: 'border-box',
    padding: '18px 22px', background: 'transparent', border: 0, borderTop: '1px solid var(--bdr)',
    textAlign: 'left', cursor: 'pointer', color: 'inherit',
  },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.4 },
  found: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', marginTop: 4, maxWidth: MEASURE },
  body: { padding: '0 22px 24px 74px' },
  foot: { padding: '0 22px 22px 74px' },
  say: { fontSize: 15, lineHeight: 1.5, color: 'var(--t1)', margin: '0 0 12px', maxWidth: MEASURE },
  quiet: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', margin: '0 0 12px', maxWidth: MEASURE },
  // 15px grey, for a line that is body copy rather than a jargon bracket.
  aside: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)' },
  // ONLY for the Adyen word in brackets on first use.
  brack: { fontSize: 13, color: 'var(--t3)', fontWeight: 400 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  idRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', flexWrap: 'wrap' },
  idLabel: { fontSize: 13, color: 'var(--t3)', minWidth: 150 },
  idValue: { fontSize: 13, color: 'var(--t3)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', wordBreak: 'break-all' },
  copy: { background: 'transparent', border: '1px solid var(--bdr2)', borderRadius: 6, color: 'var(--t3)', fontSize: 12, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.6 },
  prim: {
    minHeight: 46, padding: '12px 22px', borderRadius: 10, border: '1px solid var(--acc)',
    background: 'var(--acc)', color: '#0b0c10', fontSize: 15, fontWeight: 800, cursor: 'pointer',
    fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4,
  },
  live: { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' },
  link: {
    background: 'transparent', border: 0, padding: 0, color: 'var(--t2)', fontSize: 15,
    textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.5,
  },
  small: {
    minHeight: 34, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr2)',
    background: 'transparent', color: 'var(--t2)', fontSize: 15, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'inherit',
  },
  input: {
    boxSizing: 'border-box', height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid var(--bdr2)',
    background: 'var(--bg1)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', width: '100%',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  fieldLabel: { fontSize: 15, lineHeight: 1.5, color: 'var(--t3)', maxWidth: MEASURE },
  note: { fontSize: 15, lineHeight: 1.5, borderRadius: 10, padding: '12px 14px', margin: '14px 0 0', maxWidth: MEASURE },
  panel: { margin: '0 22px 22px', padding: '18px 20px', borderRadius: 12, background: 'var(--red-d, rgba(255,90,74,.1))', border: '1px solid var(--red-b, var(--red))' },
  panelH: { fontSize: 18, fontWeight: 800, color: 'var(--red)', margin: 0, lineHeight: 1.4 },
  panelLine: { fontSize: 15, lineHeight: 1.5, color: 'var(--t1)', margin: '10px 0 0', maxWidth: MEASURE },
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

// A secondary. It guards on busy like every other control on the page, so a
// second click during a round trip can never start a second write.
function Secondary({ busy, disabled, onClick, children }) {
  const off = !!busy || !!disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      style={{ ...S.link, opacity: off ? 0.6 : 1, cursor: off ? 'default' : 'pointer' }}
    >
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
const lines = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

// What was being done, for the one plain error sentence.
function whatFailed(key) {
  if (key === 'create') return 'The payments location could not be made';
  if (key === 'golive') return 'Live payments could not be turned on';
  if (key === 'origins') return 'The web addresses could not be added';
  if (key === 'merchant') return 'That Adyen account could not be read';
  return 'The venue could not be read';
}

// The choices the admin made for this venue (the merchant account, a pasted or
// picked id, the wide search, a different code) survive collapsing the row and
// a page reload. They used to live in component state only, so collapsing the
// venue silently went back to the secret's account (8 Sep 2026).
const pickKey = (id) => `servos.adyen.golive.pick.${id || 'unknown'}`;
function readPick(id) {
  try {
    const raw = sessionStorage.getItem(pickKey(id));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function savePick(id, v) {
  try { sessionStorage.setItem(pickKey(id), JSON.stringify(v || {})); } catch { /* private mode: the choice lives for this mount */ }
}

// The one plain line per wallet under step 4. `on` is "Adyen offers it AND it
// carries the identifiers the browser needs"; anything else names the next
// thing to do rather than leaving an operator to guess.
function walletLines(wallets) {
  if (!wallets || typeof wallets !== 'object') return [];
  const say = (label, on, extra) => ({
    label,
    on: !!on,
    text: on ? `${label}: on. Adyen offers it on this venue.` : `${label}: off. ${extra}`,
  });
  return [
    say('Apple Pay', wallets.applepay, 'Turn it on in the Adyen Customer Area, then add the web addresses below so the venue\u2019s shop is registered with Apple.'),
    say('Google Pay', wallets.googlepay, 'Turn it on in the Adyen Customer Area. It also needs a Google merchant ID on the account before a live shopper can use it.'),
  ];
}

export default function AdyenGoLiveFlow({ location, venueCode, callAdmin, wallets = null, onChanged, refreshKey = 0 }) {
  const name = location?.name || 'this venue';
  const locId = location?.id || null;
  // Every read and write carries the same identity choices: the merchant
  // account the admin picked (the live mismatch), a store or business account
  // id pasted or picked from a list, the code Adyen carries the venue under,
  // and whether the wide search was asked for.
  const [pick, setPickState] = useState(() => readPick(locId));
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadProblem, setLoadProblem] = useState(null);
  const [busy, setBusy] = useState('');
  const [openId, setOpenId] = useState(null);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pasted, setPasted] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pickedStore, setPickedStore] = useState('');
  const [pickedHolder, setPickedHolder] = useState('');
  const [merchants, setMerchants] = useState(null);
  const [merchantChoice, setMerchantChoice] = useState('');
  // The accounts list is 26 Adyen calls, so it loads on a mismatch (where it
  // is the only way forward) or when the admin asks for it.
  const [accountsOpen, setAccountsOpen] = useState(false);
  // "Look on the test system", the checkbox the deleted dense panel had.
  const [lookTest, setLookTest] = useState(false);
  // "Adyen uses a different code for this venue", the reference field the
  // deleted dense panel had.
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  const [form, setForm] = useState(() => ({ ...splitAddress(location?.address), phone: '' }));
  // The create was refused because the venue's row holds no business line:
  // the link writes it, and the link is the go live step. Offered here as a
  // small secondary so the live case (a business account with no payments
  // location) is not a dead end.
  const [linkFirst, setLinkFirst] = useState(false);
  // The in page ask that replaced window.confirm: { kind, lines }.
  const [ask, setAsk] = useState(null);
  const [liveTyped, setLiveTyped] = useState('');
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const envRef = useRef(lookTest);
  envRef.current = lookTest;

  const setPick = useCallback((next) => { setPickState(next); savePick(locId, next); }, [locId]);

  // Every call carries the environment the flow is looking at. The flow looks
  // at LIVE unless the admin ticked "Look on the test system".
  const envArg = useCallback(() => (envRef.current ? { environment: 'test' } : {}), []);

  const load = useCallback(async (nextPick) => {
    const payload = nextPick === undefined ? pickRef.current : nextPick;
    if (nextPick !== undefined) { pickRef.current = payload; setPick(payload); }
    setLoading(true);
    try {
      const r = await callAdmin('golive_state', { ...payload, ...(envRef.current ? { environment: 'test' } : {}) });
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
  }, [callAdmin, setPick]);

  useEffect(() => { load(); }, [load, refreshKey, lookTest]);

  const view = useMemo(() => goliveFlowView(state, openId), [state, openId]);
  const open = view.steps.find((x) => x.open) || null;
  const target = str(state?.target) === 'test' ? 'test' : 'live';
  const venueEnv = str(state?.venue?.environment) === 'live' ? 'live' : 'test';
  const region = str(state?.venue?.region) || 'UK';
  const reference = str(pick.reference) || str(state?.reference) || str(venueCode);
  const caps = capabilityNotices(state?.capabilities);
  const mismatch = mismatchView(state?.merchantMismatch);
  // FINDING A VENUE BY ITS REFERENCE. Adyen cannot be searched by venue code
  // on the money side, so the FIRST venue on an account pastes its Adyen id
  // once; the balance platform id behind it is kept, and every venue after it
  // is found by its reference on its own. This says which of the two we are
  // in, and the paste box drops to a small secondary the moment it is known.
  const refSearch = referenceSearchView(state);
  const readers = Array.isArray(state?.readers) ? state.readers : [];
  const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
  const holderCandidates = Array.isArray(state?.holderCandidates) ? state.holderCandidates : [];
  const stateErrors = lines(state?.errors);
  const stateNotes = lines(state?.notes);
  const readersError = str(state?.readers_error);
  const merchantNow = str(state?.merchantConfigured);
  // Apple Pay and Google Pay, read from adyen-checkout `status` by the panel
  // above and passed in. Nothing here decides: it says what Adyen answered.
  const walletRows = walletLines(wallets);
  const walletProblem = str(wallets?.error) || '';

  // The accounts the credential can see. A mismatch loads them straight away
  // (picking one is the only way forward); otherwise the admin asks.
  const wantMerchants = !!open && (mismatch ? (open.id === 'payments_location' || open.action === 'choose_merchant') : accountsOpen);
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
    setBusy(key); setProblem(null); setNotice(null);
    try {
      const done = await work();
      if (done?.notice) setNotice(done.notice);
      if (done?.problem) setProblem(done.problem);
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

  const applyHolderCandidate = () => {
    if (!pickedHolder) return;
    act('holder', async () => {
      await load({ ...pick, accountHolderId: pickedHolder });
      return { stop: true };
    });
  };

  const applyMerchant = () => {
    if (!merchantChoice) return;
    act('merchant', async () => {
      await load({ ...pick, merchantAccount: merchantChoice });
      return { stop: true, notice: { text: 'Reading the account you picked.', ids: [{ label: 'Adyen account', value: merchantChoice }] } };
    });
  };

  // The wide search: every Adyen account this credential can see. It is a lot
  // of calls, so it is asked for once and then remembered.
  const searchEverywhere = () => act('sweep', async () => {
    await load({ ...pick, sweep: true });
    return { stop: true };
  });

  const applyCode = () => {
    const v = codeDraft.trim().slice(0, 50);
    act('code', async () => {
      setCodeOpen(false);
      await load({ ...pick, ...(v ? { reference: v } : { reference: undefined }) });
      return { stop: true };
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
      ...envArg(),
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
    // A refused balance account join means the payments location exists and
    // books its money NOWHERE. It is never a silent empty string (8 Sep 2026).
    const joinFailed = r.balanceAccountLink && r.balanceAccountLink.ok === false;
    const extra = [joinFailed ? str(r.balanceAccountLink.message) : '', str(r.warning), str(r.hint)].filter(Boolean).join('\n\n');
    return {
      notice: {
        text: r.existing ? 'Adyen already had the payments location.' : 'The payments location is ready.',
        ids: [{ label: 'Payments location', value: str(r.storeId) }, { label: 'Adyen account', value: str(r.merchantAccount) }],
        line: joinFailed ? null : 'The money is joined to it.',
      },
      problem: joinFailed
        ? { text: 'The payments location was made, but the money is not joined to it yet.', detail: extra || null }
        : (extra ? { text: 'The payments location was made. Adyen said something else as well.', detail: extra } : null),
      changed: true,
    };
  });

  // GOING LIVE ALWAYS ASKS, IN PAGE. The panel is built from a fresh read, so
  // it says what is kept and what comes back, one line per consequence, and it
  // makes an admin type LIVE before the red button works.
  const askGoLive = () => act('golive', async () => {
    const look = await callAdmin('adyen_lookup', { ...pickRef.current, ...envArg() });
    if (look?.ok === false) throw new Error(look.error || 'the venue could not be read');
    setAsk({ kind: 'golive', lines: goLiveConfirmLines(look, name) });
    setLiveTyped('');
    setOpenId('go_live');
    return { stop: true };
  });

  const doGoLive = (relink) => act('golive', async () => {
    let r;
    try {
      r = await callAdmin('adyen_link', { ...pickRef.current, ...envArg(), ...(relink ? { relink: true } : {}) });
    } catch (e) {
      if (e?.data?.needs_relink && !relink) {
        setAsk({ kind: 'relink', lines: relinkConfirmLines(e.data) });
        setLiveTyped('');
        return { stop: true };
      }
      throw e;
    }
    if (r?.ok === false) throw new Error(r.error || 'the link did not go through');
    setAsk(null); setLiveTyped('');
    // NEVER "takes real cards now" for a venue the same write just marked
    // unable to take one (8 Sep 2026: the storeless live link says both).
    const text = r.unchanged ? `${name} was already linked.`
      : r.storeNeeded ? `${name} is live, but it cannot take a card until it has a payments location.`
      : str(r.environment) !== 'live' ? `${name} is linked on test.`
      : r.patch?.receive_payments_ok === true ? `${name} takes real cards now.`
      : `${name} is live. Finish the steps below before taking a card.`;
    const warned = lines(r.warnings).filter((w) => w !== str(r.storeNeeded));
    return {
      notice: { text, ids: [{ label: 'Payments location', value: str(r.patch?.store_id) }] },
      problem: warned.length ? { text: 'It went through. Adyen said something else as well.', detail: warned.join('\n\n') } : null,
      changed: true,
    };
  });

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
    return { notice: { text: added ? `${added} web address${added === 1 ? '' : 'es'} added.` : 'The web addresses were already in place.' }, changed: true };
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
  const anyBusy = !!busy;
  // The typed word is only asked for when this click starts real money.
  const needsTyped = ask?.kind === 'golive' && target === 'live' && venueEnv !== 'live';
  const typedOk = !needsTyped || liveTyped.trim().toUpperCase() === 'LIVE';

  // The mismatch block: the two accounts and the picker. It renders on
  // whichever step owns the choice, so the explanation is never one row down
  // behind a click.
  const mismatchBlock = mismatch ? (
    <div style={{ marginBottom: 18 }}>
      <p style={S.say}>{mismatch.text}</p>
      <IdLine label="Where the venue is" value={mismatch.theirs} />
      <IdLine label="What we are set to use" value={mismatch.ours} />
      {merchants === null && <p style={S.quiet}>Reading the Adyen accounts we can see.</p>}
      {merchants?.error && <Problem problem={merchants.error} tone="warn" />}
      {picker && picker.options.length > 0 && (
        <div style={{ marginTop: 14, maxWidth: 520 }}>
          <label style={S.field}>
            <span style={S.fieldLabel}>Pick the right account for this venue</span>
            <select style={S.input} value={merchantChoice} disabled={anyBusy} onChange={(e) => setMerchantChoice(e.target.value)}>
              <option value="">Pick one</option>
              {picker.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <div style={{ marginTop: 14 }}>
            <Primary busy={busy === 'merchant'} disabled={!merchantChoice} onClick={applyMerchant}>Use this account</Primary>
          </div>
        </div>
      )}
      {picker && picker.options.length === 0 && (
        <>
          <Problem
            tone="warn"
            problem={{ text: 'The Adyen accounts could not be listed, so the right one has to be set on the server.', detail: picker.error || null }}
          />
          <div style={{ marginTop: 10 }}>
            <IdLine label="Server setting" value={picker.secret} />
            <IdLine label="Account to point it at" value={mismatch.theirs} />
          </div>
        </>
      )}
    </div>
  ) : null;

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
          const mismatchSpeaks = !!mismatch && (step.id === 'payments_location' || step.action === 'choose_merchant');
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
                    <div style={{ margin: '0 0 12px', maxWidth: MEASURE }}>
                      {caps.map((c) => (
                        <div key={c.name} style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 4, color: c.tone === 'bad' ? 'var(--red)' : 'var(--orn, #e8a020)' }}>
                          {c.text} <span style={S.brack}>({c.label})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {step.hint && !mismatchSpeaks && <p style={S.quiet}>{step.hint}</p>}
                  {mismatchSpeaks && mismatchBlock}

                  {/* ── 1. find the venue ── */}
                  {step.id === 'find_venue' && (
                    <>
                      {/* ONE line, whichever of the two this account is in:
                          nothing known yet and the id gets pasted once, or the
                          venue was just found by its reference on its own. */}
                      {refSearch.firstVenueLine && <p style={S.quiet}>{refSearch.firstVenueLine}</p>}
                      {refSearch.foundLine && <p style={S.quiet}>{refSearch.foundLine}</p>}
                      {/* Not on the paste first path: firstVenueLine has just
                          said to paste the id once, and a server secret name
                          under it is a second, contradicting instruction. The
                          secret is still named in the server's own note. */}
                      {state.needsBalancePlatform && !refSearch.pastePrimary && <IdLine label="Server setting still needed" value={str(state.balancePlatformSecret)} />}
                      {/* Pasting the id IS the way forward when there is no
                          venue code to search for, and when no balance
                          platform id is known yet (the first venue on this
                          Adyen account). Then the box is open and carries the
                          one primary. The moment the id IS known, "Look again"
                          takes the primary and the box drops to the small
                          secondary below it. */}
                      {noCode || refSearch.pastePrimary ? (
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
                          <div style={{ marginTop: 14, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Primary busy={busy === 'paste'} disabled={!pastedLooksRight || anyBusy} onClick={applyPastedId}>Use this id</Primary>
                            {/* There is still a code to search stores for, so
                                the plain search stays available beside it. */}
                            {!noCode && (
                              <Secondary busy={anyBusy} onClick={() => act('look', async () => ({}))}>
                                {busy === 'look' ? 'Looking' : 'Look again'}
                              </Secondary>
                            )}
                          </div>
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Primary busy={busy === 'look'} disabled={anyBusy} onClick={() => act('look', async () => ({}))}>Look again</Primary>
                            {!pasteOpen && <Secondary busy={anyBusy} onClick={() => setPasteOpen(true)}>I have the Adyen id</Secondary>}
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
                              <button type="button" style={{ ...S.small, opacity: pastedLooksRight && !anyBusy ? 1 : 0.6 }} disabled={!pastedLooksRight || anyBusy} onClick={applyPastedId}>
                                {busy === 'paste' ? <Spinner /> : null}Use it
                              </button>
                            </div>
                          )}
                        </>
                      )}

                      {/* Everything below is the same under both paths: what
                          Adyen answered, the wide search, the other code. Only
                          a venue with NO code has nothing to search for, so it
                          gets none of it. */}
                      {!noCode && (
                        <>
                          {candidates.length > 0 && (
                            <div style={{ marginTop: 18, maxWidth: 520 }}>
                              <label style={S.field}>
                                <span style={S.fieldLabel}>Or pick the venue from the {candidates.length} places Adyen holds on this account</span>
                                <select style={S.input} value={pickedStore} disabled={anyBusy} onChange={(e) => setPickedStore(e.target.value)}>
                                  <option value="">Pick one</option>
                                  {candidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
                                </select>
                              </label>
                              <div style={{ marginTop: 10 }}>
                                <Secondary busy={anyBusy} disabled={!pickedStore} onClick={applyCandidate}>
                                  {busy === 'candidate' ? 'Reading it' : 'Use the one I picked'}
                                </Secondary>
                              </div>
                            </div>
                          )}
                          {holderCandidates.length > 0 && (
                            <div style={{ marginTop: 18, maxWidth: 520 }}>
                              <label style={S.field}>
                                <span style={S.fieldLabel}>Or pick the business account from the {holderCandidates.length} Adyen holds</span>
                                <select style={S.input} value={pickedHolder} disabled={anyBusy} onChange={(e) => setPickedHolder(e.target.value)}>
                                  <option value="">Pick one</option>
                                  {holderCandidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
                                </select>
                              </label>
                              <div style={{ marginTop: 10 }}>
                                <Secondary busy={anyBusy} disabled={!pickedHolder} onClick={applyHolderCandidate}>
                                  {busy === 'holder' ? 'Reading it' : 'Use the business account I picked'}
                                </Secondary>
                              </div>
                            </div>
                          )}
                          {/* The wide search, the test system and a different
                              code: three small choices, never in the way. */}
                          <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', marginTop: 18 }}>
                            {!state.swept && !pick.sweep && (
                              <Secondary busy={anyBusy} onClick={searchEverywhere}>
                                {busy === 'sweep' ? 'Searching every account' : 'Search every Adyen account'}
                              </Secondary>
                            )}
                            {!codeOpen && (
                              <Secondary busy={anyBusy} onClick={() => { setCodeDraft(reference); setCodeOpen(true); }}>
                                Adyen uses a different code for this venue
                              </Secondary>
                            )}
                            <label style={{ ...S.aside, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: anyBusy ? 'default' : 'pointer' }}>
                              <input type="checkbox" checked={lookTest} disabled={anyBusy} onChange={(e) => setLookTest(e.target.checked)} />
                              Look on the test system
                            </label>
                          </div>
                          {codeOpen && (
                            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 14, maxWidth: 460 }}>
                              <label style={{ ...S.field, flex: '1 1 240px' }}>
                                <span style={S.fieldLabel}>The code Adyen carries this venue under</span>
                                <input
                                  style={{ ...S.input, ...S.mono }}
                                  value={codeDraft}
                                  onChange={(e) => setCodeDraft(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') applyCode(); }}
                                  spellCheck={false}
                                  autoComplete="off"
                                />
                              </label>
                              <button type="button" style={{ ...S.small, opacity: anyBusy ? 0.6 : 1 }} disabled={anyBusy} onClick={applyCode}>
                                {busy === 'code' ? <Spinner /> : null}Look for this
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      {(state.store?.id || state.holder?.id) && (
                        <div style={{ marginTop: 16 }}>
                          <IdLine label={<>{term('store')}</>} value={state.store?.id} />
                          <IdLine label={<>{term('holder')}</>} value={state.holder?.id} />
                        </div>
                      )}
                    </>
                  )}

                  {/* ── 2. the Adyen business account ── */}
                  {step.id === 'business_account' && (
                    <>
                      {(step.action === 'open_adyen' || step.action === 'send_onboarding' || caps.length > 0) && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary disabled={anyBusy} onClick={openAdyen}>Open Adyen</Primary>
                          <Secondary busy={anyBusy} onClick={() => act('look2', async () => ({}))}>{busy === 'look2' ? 'Checking' : 'Check again'}</Secondary>
                        </div>
                      )}
                      {step.action === 'find_venue' && (
                        <Primary busy={busy === 'look'} disabled={anyBusy} onClick={() => act('look', async () => ({}))}>Look again</Primary>
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
                          {/* WHICH ADYEN ACCOUNT IT GOES ON, said out loud
                              before the button, and changeable. The venue's
                              business account can sit on one account while the
                              secret names another (live, 8 Sep 2026). */}
                          <p style={S.say}>
                            {merchantNow ? <>Making it on <span style={S.mono}>{merchantNow}</span>.</> : 'Making it on the Adyen account the server names.'}
                          </p>
                          {!accountsOpen && (
                            <div style={{ margin: '0 0 14px' }}>
                              <Secondary busy={anyBusy} onClick={() => setAccountsOpen(true)}>Not this account?</Secondary>
                            </div>
                          )}
                          {accountsOpen && (
                            <div style={{ margin: '0 0 18px', maxWidth: 520 }}>
                              {merchants === null && <p style={S.quiet}>Reading the Adyen accounts we can see.</p>}
                              {merchants?.error && <Problem problem={merchants.error} tone="warn" />}
                              {picker && picker.options.length > 0 && (
                                <>
                                  <label style={S.field}>
                                    <span style={S.fieldLabel}>Pick the right account for this venue</span>
                                    <select style={S.input} value={merchantChoice} disabled={anyBusy} onChange={(e) => setMerchantChoice(e.target.value)}>
                                      <option value="">Pick one</option>
                                      {picker.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                  </label>
                                  <div style={{ marginTop: 10 }}>
                                    <Secondary busy={anyBusy} disabled={!merchantChoice} onClick={applyMerchant}>
                                      {busy === 'merchant' ? 'Reading it' : 'Use this account'}
                                    </Secondary>
                                  </div>
                                </>
                              )}
                              {picker && picker.options.length === 0 && (
                                <>
                                  <Problem
                                    tone="warn"
                                    problem={{ text: 'The Adyen accounts could not be listed, so the right one has to be set on the server.', detail: picker.error || null }}
                                  />
                                  <div style={{ marginTop: 10 }}><IdLine label="Server setting" value={picker.secret} /></div>
                                </>
                              )}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Primary busy={busy === 'create'} disabled={!canCreate || anyBusy} onClick={createStore}>Make the payments location</Primary>
                            {linkFirst && (
                              <Secondary busy={anyBusy} onClick={askGoLive}>{busy === 'golive' ? 'Working' : 'Turn on live payments first'}</Secondary>
                            )}
                          </div>
                        </>
                      )}

                      {!mismatch && step.action === 'open_adyen' && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary disabled={anyBusy} onClick={openAdyen}>Open Adyen</Primary>
                          <Secondary busy={anyBusy} onClick={() => act('look3', async () => ({}))}>{busy === 'look3' ? 'Checking' : 'Check again'}</Secondary>
                        </div>
                      )}

                      {!mismatch && (
                        <div style={{ marginTop: 16 }}>
                          <IdLine label={<>{term('store')}</>} value={state.store?.id} />
                          <IdLine label="Adyen account" value={str(state.store?.merchantId) || merchantNow} />
                        </div>
                      )}
                    </>
                  )}

                  {/* ── 4. turn on live payments ── */}
                  {step.id === 'go_live' && (
                    <>
                      {step.action === 'go_live' && !ask && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary busy={busy === 'golive'} disabled={anyBusy} live onClick={askGoLive}>Turn on live payments</Primary>
                          <span style={S.aside}>You are asked to confirm first.</span>
                        </div>
                      )}
                      {step.action === 'register_origins' && (
                        <Primary busy={busy === 'origins'} disabled={anyBusy} onClick={addOrigins}>Add the web addresses</Primary>
                      )}
                      {/* WHAT THE SHOPPER WILL ACTUALLY SEE. The checkout asks
                          Adyen for the venue's real payment methods and falls
                          back to a plain card form in silence when a wallet is
                          not there, so this is the only place an operator can
                          read the answer. */}
                      {walletRows.length > 0 && (
                        <div style={{ marginTop: 18, maxWidth: MEASURE }}>
                          {walletRows.map((w) => (
                            <div key={w.label} style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 6, color: w.on ? 'var(--grn, #15C26A)' : 'var(--t3)' }}>
                              {w.text}
                            </div>
                          ))}
                          {walletProblem && <p style={{ ...S.quiet, marginTop: 6 }}>{walletProblem}</p>}
                        </div>
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
                              <span style={S.aside}> {r.bound ? 'on a till' : 'not on a till yet'}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <Primary busy={busy === 'readers'} disabled={anyBusy} onClick={() => act('readers', async () => ({}))}>Check again</Primary>
                      {readers.length > 0 && (
                        <div style={{ marginTop: 16 }}>
                          {readers.map((r) => <IdLine key={r.poiid} label={str(r.label) || 'Card machine'} value={r.poiid} />)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* THE ONE ASK BEFORE REAL MONEY, in page, at the same size as the
            rest of the screen: one line per consequence, then the typed word
            LIVE. It replaced a native window.confirm holding up to six
            paragraphs at the OS default size (8 Sep 2026). */}
        {ask && (
          <div style={S.panel}>
            <h4 style={S.panelH}>
              {ask.kind === 'relink' ? `Link ${name} again?` : `Turn on live payments for ${name}?`}
            </h4>
            {ask.lines.map((l, i) => <p key={i} style={S.panelLine}>{l}</p>)}
            {needsTyped && (
              <div style={{ marginTop: 16, maxWidth: 320 }}>
                <label style={S.field}>
                  <span style={{ ...S.fieldLabel, color: 'var(--t1)' }}>Type LIVE to confirm.</span>
                  <input
                    style={{ ...S.input, ...S.mono, letterSpacing: '.1em' }}
                    value={liveTyped}
                    onChange={(e) => setLiveTyped(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && typedOk && !anyBusy) doGoLive(ask.kind === 'relink'); }}
                    placeholder="LIVE"
                    autoFocus
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 18 }}>
              <Primary busy={busy === 'golive'} disabled={!typedOk || anyBusy} live onClick={() => doGoLive(ask.kind === 'relink')}>
                {ask.kind === 'relink' ? 'Link it again' : 'Turn on live payments'}
              </Primary>
              <Secondary busy={anyBusy} onClick={() => { setAsk(null); setLiveTyped(''); }}>Not now</Secondary>
            </div>
          </div>
        )}

        {/* WHAT HAPPENED, in one place under the steps so it never vanishes
            with the step that caused it, and so an Adyen refusal the read
            answered 200 with can never look like "nothing found". */}
        {(notice || problem || loadProblem || (!view.allDone && stateErrors.length) || readersError) && (
          <div style={S.foot}>
            {notice && (
              <div style={{ ...S.note, background: CHIP.ok.bg, border: `1px solid ${CHIP.ok.bd}`, color: CHIP.ok.fg }}>
                <div>{notice.text}</div>
                {notice.line && <div style={{ marginTop: 4 }}>{notice.line}</div>}
              </div>
            )}
            {notice && Array.isArray(notice.ids) && (
              <div style={{ marginTop: 8 }}>
                {notice.ids.filter((x) => str(x.value)).map((x) => <IdLine key={x.label} label={x.label} value={x.value} />)}
              </div>
            )}
            <Problem problem={problem} />
            {loadProblem && <Problem problem={loadProblem} tone="warn" />}
            {!view.allDone && stateErrors.length > 0 && (
              <Problem
                tone="warn"
                problem={{
                  text: 'Adyen did not answer everything, so what is on screen may not be the whole picture.',
                  detail: [...stateErrors, ...stateNotes].join('\n\n'),
                }}
              />
            )}
            {readersError && (
              <Problem tone="warn" problem={{ text: 'The card reader list could not be read, so step 5 may be wrong.', detail: readersError }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
