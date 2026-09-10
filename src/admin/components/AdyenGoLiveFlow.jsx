// src/admin/components/AdyenGoLiveFlow.jsx
//
// ServOS admin portal (?mode=admin): GET THIS VENUE TAKING CARDS, the guided
// six step flow that replaced the dense "Link to Adyen" panel on 8 Sep 2026
// (five steps then; step 5, Card rates and payouts, arrived 9 Sep 2026 and
// was rebuilt on 10 Sep 2026 around the venue rate card).
//
// OWNER FEEDBACK (8 Sep 2026, verbatim): "we need this to be easier and better
// there is far too many words and too small we need a flow that supports
// someone doing this". So:
//   1. Six numbered steps down the page, one open at a time. A done step
//      collapses to its title, a tick and one line. Step 5 has two parts
//      (the card rates, the payouts), each its own line and one button.
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
//      location (store), Card reader (terminal).
//   5. Ids are secondary: small, monospace, grey, with a copy button. Never
//      in a sentence.
//   6. An error is one plain sentence: what happened and what to do next. The
//      raw answer hides behind a small "Show detail". That includes the ones
//      golive_state answers 200 with (`problems`, one plain line each with the
//      raw answer in rawDetail): a refusal Adyen gave us must never look like
//      "nothing found". The box under the steps shows at most three lines,
//      and NEVER the Balance Platform refusal (step 2 says that once) or the
//      merchant mismatch (its own block). 9 Sep 2026: the live screen showed
//      four long code lines for one fact and the owner read "errors all over
//      the place, I dont know whats happening".
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
//   adyen_link                       ONE write of the ids + the flip to live;
//                                    ALSO "Save it on the venue" (link_store
//                                    and link_holder, 9 Sep 2026): the same
//                                    call on the venue's own environment with
//                                    the store id or the account holder id the
//                                    read found, so what Adyen holds lands on
//                                    the row without touching anything else.
//                                    Each save carries the OTHER id too when
//                                    it is known and the row does not name a
//                                    different one, so nobody saves twice
//   set_split                        step 5a: the venue's RATE CARD on the
//                                    store, one rule per payment type, with
//                                    NO numbers in the body (10 Sep 2026):
//                                    the server applies the resolved card
//                                    and refuses naming any unpriced tier
//   set_balance_platform             step 1: the balance platform id, typed
//                                    ONCE per region when the first read
//                                    could not learn it (10 Sep 2026)
//   adyen_link (link_all)            steps 2 and 3 in ONE click when the read
//                                    found the store and the business
//                                    account and the row names neither
//   payments-admin adyen_pricing     step 5a, Edit rates: the venue rate card
//                                    read and saved through callPayments
//   onboarding_link                  step 5b: the bank details link (4 minutes,
//                                    once) for the venue owner
//   setup_sweep                      step 5b: pay the venue out daily
//   request_payouts                  step 5b: ask Adyen for the payout
//                                    capability it was never asked for
//   The three step 5 writes and request_payouts name the environment the
//   flow is LOOKING at, so the server refuses them while the venue is on
//   the other one (they act on the venue's own row).
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
// NOTHING PASTED, FOR ANY VENUE (10 Sep 2026, OWNER: "there is no way copying
// and pasting codes backwards and forwards is the only way to do this"). With
// the balance platform id known for the venue's environment and region, the
// server pages Adyen's account holders and matches the venue code, and the
// store is found by its reference. Step 1 draws whichever of the two it is
// in, from referenceSearchView:
//   no platform id yet  ONE input, the balance platform id (the name Adyen
//                       shows, FranPOS_UK, or its BP id), saved once per
//                       region with set_balance_platform; the read runs again
//   known               "Find on Adyen" is the one primary and there is no box
//   found by reference  one line saying so, so the admin sees it working
// Pasting an account holder or store id lives under Advanced (collapsed) as
// a last resort, and is the way forward only for a venue with no code.
//
// CARD RATES (10 Sep 2026, OWNER: "we set the rate that customers get charged
// for the different card types, out of the money the adyen charge whats left
// is ours"). Step 5a draws the venue's rate card as four big rows (Payment
// type, Rate, Per payment, one grey source word) from golive_state's `rates`,
// ONE primary "Apply these rates on Adyen" (set_split with no numbers), and
// "Edit rates" opens the same four row editor Processing uses (RateCardRows),
// saved through payments-admin adyen_pricing. No two box flat path, no typed
// CONFIRM, and never the word commission on screen.
//
// Props:
//   location    the platform locations row (id, name, address)
//   venueCode   ops locations.venue_code, for the empty state line
//   callAdmin   (action, payload) => the adyen-terminal-admin answer; MUST
//               throw on a non-2xx with err.status and err.data set
//   callPayments (action, payload) => the payments-admin answer (throws on
//               error). Step 5a's Edit rates reads and saves the venue rate
//               card through it (adyen_pricing). Without it the editor is
//               not offered and the rates are edited in Processing
//   wallets     adyen-checkout `status` (wallets: true) probe for this venue:
//               { applepay, googlepay, offered[], error }. null = not read.
//               Step 4 says it out loud, because "the owner asked why Apple
//               Pay did not load" was previously unanswerable anywhere in the
//               product: the checkout falls back to a card-only form in
//               silence, and a scheme-only Adyen answer did not even warn.
//   onChanged   fired after anything changed the venue
//   refreshKey  bump it to make the flow read again

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  goliveFlowView, capabilityNotices, mismatchView, plainFailure, referenceSearchView,
  goLiveConfirmLines, relinkConfirmLines, relinkStoreConfirmView, merchantPicker, candidateLabel,
  goliveProblemBox, PLATFORM_SETTINGS_WAITING_LINE, RATES_LEDE, rateCardRows, PLATFORM_ID_LINE,
} from '../../lib/payments/adyenAdminRows';
import { isPlatformSettingsMissingWarning, rateCardProblems } from '../../lib/payments/adyenLink';
import { cardToState, stateToCard, cardsEqual } from '../../lib/payments/rateCard';
import RateCardRows from './RateCardRows';

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
  reader: ['Card reader', 'terminal'],
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
// `big` draws it at 15px, for the one row that IS the thing to do rather than
// a reference id (the server setting the Balance Platform key goes in).
function IdLine({ label, value, big = false }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(value)); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked: the id is on screen to read */ }
  };
  return (
    <div style={S.idRow}>
      <span style={big ? { ...S.idLabel, fontSize: 15, color: 'var(--t2)' } : S.idLabel}>{label}</span>
      <span style={big ? { ...S.idValue, fontSize: 15, color: 'var(--t1)' } : S.idValue}>{value}</span>
      <button type="button" style={S.copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// One plain sentence, with the raw answer behind a small toggle. `lines` (at
// most three, goliveProblemBox) are the plain lines under it, one each.
function Problem({ problem, tone = 'bad' }) {
  const [open, setOpen] = useState(false);
  if (!problem?.text) return null;
  const c = CHIP[tone] || CHIP.bad;
  const extra = Array.isArray(problem.lines) ? problem.lines.map((l) => (typeof l === 'string' ? l : l?.text)).filter(Boolean) : [];
  return (
    <div style={{ ...S.note, background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}>
      <div>{problem.text}</div>
      {extra.map((l) => <div key={l} style={{ marginTop: 6 }}>{l}</div>)}
      {Number(problem.more) > 0 && <div style={{ marginTop: 6 }}>And {problem.more} more, under Show detail.</div>}
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

// THE CARD RATES TABLE (10 Sep 2026): four rows, big type, Payment type,
// Rate, Per payment, and one grey source word per row (rateCardRows). Read
// only: Edit rates opens the editor under it.
function RatesTable({ rows }) {
  const head = { fontSize: 15, fontWeight: 700, color: 'var(--t3)' };
  const cell = { fontSize: 17, lineHeight: 1.4, color: 'var(--t1)' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1.4fr) 1fr 1.4fr', gap: '8px 14px', maxWidth: 520, margin: '4px 0 0', alignItems: 'baseline' }}>
      <span style={head}>Payment type</span>
      <span style={head}>Rate</span>
      <span style={head}>Per payment</span>
      {rows.map((r) => (
        <Fragment key={r.id}>
          <span style={{ ...cell, fontWeight: 700 }}>{r.label}</span>
          <span style={{ ...cell, fontWeight: 800, color: r.unpriced ? 'var(--orn, #e8a020)' : 'var(--t1)' }}>{r.rate}</span>
          <span style={cell}>
            {r.perPayment}
            {r.source && <span style={{ ...S.aside, marginLeft: r.perPayment ? 8 : 0 }}>{r.source}</span>}
          </span>
        </Fragment>
      ))}
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
  if (key === 'save_store') return 'The payments location could not be saved on the venue';
  if (key === 'save_holder') return 'The business account could not be saved on the venue';
  if (key === 'save_all') return 'The Adyen details could not be saved on the venue';
  if (key === 'split') return 'The rates could not be applied on Adyen';
  if (key === 'platform') return 'The Adyen platform name could not be saved';
  if (key === 'rates_read') return 'The rates could not be read';
  if (key === 'rates') return 'The rates could not be saved';
  if (key === 'bank_link') return 'The bank details link could not be made';
  if (key === 'sweep') return 'The daily payout could not be switched on';
  if (key === 'request') return 'Adyen could not be asked for payouts';
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

export default function AdyenGoLiveFlow({ location, venueCode, callAdmin, callPayments = null, wallets = null, onChanged, refreshKey = 0 }) {
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
  // Step 1 (10 Sep 2026): the balance platform id typed once per region, and
  // the collapsed Advanced block that holds the last resort paste box.
  const [bpDraft, setBpDraft] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  // Step 5 (10 Sep 2026): the rate card editor while Edit rates is open
  // ({ value, saved, defaults, account, ready }, null = closed), and the bank
  // details link minted on the click (it works once, for 4 minutes, so it is
  // shown at once with Copy and never kept past this mount).
  const [rateEdit, setRateEdit] = useState(null);
  const [bankLink, setBankLink] = useState(null);
  // Apply these rates on Adyen answered over_limit (a rate above the usual
  // limit, 14 typed for 1.4): { lines }. The next press sends over_limit.
  const [splitOver, setSplitOver] = useState(null);
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
  // A SAVE ELSEWHERE ON THE PAGE (Processing's Card rates) bumps refreshKey.
  // An open editor holds the card as it was when it opened, so it closes
  // rather than save that old card over the newer one (10 Sep 2026); the
  // server refuses a stale save as well (expected_rate_card).
  useEffect(() => { setRateEdit(null); setSplitOver(null); }, [refreshKey]);

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
  // ONE amber box for what Adyen did not answer: at most three plain lines,
  // the raw answers behind Show detail, and nothing the steps already say
  // (the Balance Platform refusal sits at step 2, the mismatch in its block).
  // The reader list failing is one of those lines now, not its own box.
  const problemBox = view.allDone ? null : goliveProblemBox(state?.problems);
  const merchantNow = str(state?.merchantConfigured);
  // THE VENUE RATE CARD as the server resolved it (golive_state `rates`, the
  // old `commission` name read as an alias): four tiers with a source word
  // each, and what Adyen holds against them. The screen decides nothing.
  const isRates = (v) => !!v && typeof v === 'object' && !!v.tiers && typeof v.tiers === 'object';
  const rates = isRates(state?.rates) ? state.rates : isRates(state?.commission) ? state.commission : {};
  const rateRows = rateCardRows(rates);
  const ratesKnown = !!state?.row && isRates(rates);
  // Blank venue field in the editor: the platform default card, then (in
  // person only) the legacy flat markup, the same chain the server resolves.
  const rateFallback = (tierId, field) => {
    const d = rateEdit?.defaults || {};
    const a = rateEdit?.account || {};
    const defVal = d.rate_card?.[tierId]?.[field];
    if (defVal !== null && defVal !== undefined) return { value: Number(defVal), label: 'platform default' };
    if (tierId === 'card_present') {
      const legacyVenue = field === 'percent' ? a.markup_percent : a.markup_fixed_pence;
      if (legacyVenue !== null && legacyVenue !== undefined) return { value: Number(legacyVenue), label: 'old venue rate' };
      const legacyDef = field === 'percent' ? d.default_markup_percent : d.default_markup_fixed_pence;
      if (legacyDef !== null && legacyDef !== undefined) return { value: Number(legacyDef), label: 'old platform rate' };
    }
    return { value: null, label: null };
  };
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
      setPasted('');
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
    // What else the write said, in plain lines (the lookup's problems minus
    // the two the screen says elsewhere), with the raw warnings behind Show
    // detail. Never the "linked with gaps" line: its pieces are the same
    // problems, already plain above.
    // Never the settings table migration sentence: it is our own table, not
    // Adyen, and the top line of the flow already says it in short words.
    const box = goliveProblemBox(r.problems);
    const warned = lines(r.warnings).filter((w) => !/^Linked with gaps/i.test(w) && w !== str(r.storeNeeded) && !isPlatformSettingsMissingWarning(w));
    const detail = [box?.detail, ...warned].filter(Boolean).join('\n\n');
    return {
      notice: { text, ids: [{ label: 'Payments location', value: str(r.patch?.store_id) }] },
      // It went through, so the note is amber, never the red of a failure.
      problem: box || warned.length
        ? { text: 'It went through. Adyen said something else as well.', tone: 'warn', lines: box ? box.lines : [], more: box ? box.more : 0, detail: detail || null }
        : null,
      changed: true,
    };
  });

  // A FOUND STORE GETS SAVED (9 Sep 2026, live screen: the read found the
  // store at Adyen, the venue row still held store_id NULL and the list chip
  // read NOT LINKED). This is adyen_link on the venue's OWN environment with
  // the store id the read found: store_id, the split configuration and
  // balance account the store carries, the merchant account and
  // receive_payments_ok land on the row, the environment is not touched, and
  // the web addresses and Apple Pay domains follow best effort. It works with
  // the Balance Platform read refused: the business account pieces are simply
  // not written, and step 2 says why. A row that already names ANOTHER store
  // answers 409 needs_relink, which becomes the in page ask below.
  const saveStore = (relink) => act('save_store', async () => {
    const storeId = str(state?.store?.id);
    if (!storeId) return { stop: true };
    let r;
    try {
      // The venue's OWN environment, named out loud: link_store is only ever
      // offered when the flow looks at the environment the venue is on, and
      // resolveLinkEnvironment keeps a live venue on live whatever is passed,
      // so this write can never ride a flip.
      // The business account rides along when the read found one and the
      // row names no other (9 Sep 2026): one click saves both, nobody saves
      // twice. A row that names a DIFFERENT holder keeps it out of this
      // click, so the store save can never turn into a holder replacement.
      const holderId = str(state?.holder?.id);
      const rowHolder = str(state?.row?.account_holder_id);
      const withHolder = holderId && (!rowHolder || rowHolder === holderId) ? { accountHolderId: holderId } : {};
      // ONLY the ids the guards above chose ride (9 Sep 2026): the pick can
      // hold a pasted or picked storeId and accountHolderId, and spreading it
      // whole sent an id the guard had decided to leave out, so the server
      // planned a conflict on it and asked to replace the wrong thing.
      const { storeId: _pickedStore, accountHolderId: _pickedHolder, ...pickRest } = pickRef.current;
      r = await callAdmin('adyen_link', { ...pickRest, ...withHolder, storeId, environment: venueEnv, ...(relink ? { relink: true } : {}) });
    } catch (e) {
      if (e?.data?.needs_relink && !relink) {
        // Plain lines and the ids as grey rows, from plan.diff.conflicts: the
        // fn's own reason is a 150 to 200 character sentence with column
        // names and ids inside it, and it stays in the audit log only. The
        // "cleared" line appears only when the replacement moves the money
        // side, the one case the server clears anything (relinkClear).
        setAsk({ kind: 'relink_store', ...relinkStoreConfirmView(e.data) });
        setLiveTyped('');
        return { stop: true };
      }
      throw e;
    }
    if (r?.ok === false) throw new Error(r.error || 'the payments location was not saved');
    setAsk(null); setLiveTyped('');
    // What else the write said, in plain lines: the lookup's problems minus
    // the two the screen says elsewhere, plus any warning about the write
    // itself (a region migration, the kept ids). Never the "linked with gaps"
    // line: its pieces are the same problems, already plain above.
    // Never the settings table migration sentence (9 Sep 2026): it is our own
    // table, not something Adyen said, and the top line of the flow already
    // carries it in short words. It came back here as a red box on the very
    // next click after the flow was made plain.
    const box = goliveProblemBox(r.problems);
    const said = lines(r.warnings).filter((w) => !/^Linked with gaps/i.test(w) && w !== str(r.storeNeeded) && !isPlatformSettingsMissingWarning(w));
    const detail = [box?.detail, ...said].filter(Boolean).join('\n\n');
    return {
      notice: {
        text: r.unchanged ? 'The payments location was already on the venue.' : 'The payments location is saved on the venue.',
        ids: [{ label: 'Payments location', value: storeId }],
      },
      // It is saved, so the note is amber, never the red of a failure.
      problem: box || said.length
        ? { text: 'It is saved. Adyen said something else as well.', tone: 'warn', lines: box ? box.lines : [], more: box ? box.more : 0, detail: detail || null }
        : null,
      changed: true,
    };
  });

  // A FOUND HOLDER GETS SAVED (9 Sep 2026, live screen: golive_state read the
  // pasted account holder, said step 2 was Done, and the row still held
  // account_holder_id NULL so the list chips read NO HOLDER and NO PAYOUTS).
  // This is adyen_link on the venue's OWN environment with the account holder
  // id the read found: the holder, where the money lands, the registered
  // company, the business line, the bank account, the KYC snapshot and the
  // payout flag land on the row. The store rides along when the row already
  // names it or names none (so the same click writes both and the store's
  // own flag is read fresh); a row naming a DIFFERENT store keeps it out. A
  // row that names another holder answers 409 needs_relink: the in page ask.
  const saveHolder = (relink) => act('save_holder', async () => {
    const holderId = str(state?.holder?.id);
    if (!holderId) return { stop: true };
    const foundStore = !mismatch && str(state?.store?.id) && str(state?.store?.status).toLowerCase() === 'active' ? str(state.store.id) : '';
    const rowStore = str(state?.row?.store_id);
    const storeId = rowStore || foundStore;
    const withStore = storeId && (!rowStore || !foundStore || rowStore === foundStore) ? { storeId } : {};
    let r;
    try {
      // Only the ids the guards chose ride (the same rule as saveStore).
      const { storeId: _pickedStore, accountHolderId: _pickedHolder, ...pickRest } = pickRef.current;
      r = await callAdmin('adyen_link', { ...pickRest, ...withStore, accountHolderId: holderId, environment: venueEnv, ...(relink ? { relink: true } : {}) });
    } catch (e) {
      if (e?.data?.needs_relink && !relink) {
        setAsk({ kind: 'relink_holder', ...relinkStoreConfirmView(e.data) });
        setLiveTyped('');
        return { stop: true };
      }
      throw e;
    }
    if (r?.ok === false) throw new Error(r.error || 'the business account was not saved');
    setAsk(null); setLiveTyped('');
    const box = goliveProblemBox(r.problems);
    const said = lines(r.warnings).filter((w) => !/^Linked with gaps/i.test(w) && w !== str(r.storeNeeded) && !isPlatformSettingsMissingWarning(w));
    const detail = [box?.detail, ...said].filter(Boolean).join('\n\n');
    return {
      notice: {
        text: r.unchanged ? 'The business account was already on the venue.' : 'The business account is saved on the venue.',
        ids: [
          { label: 'Adyen business account', value: holderId },
          { label: 'Where the money lands', value: str(r.patch?.balance_account_id) },
          { label: 'Registered company', value: str(r.patch?.legal_entity_id) },
        ],
      },
      problem: box || said.length
        ? { text: 'It is saved. Adyen said something else as well.', tone: 'warn', lines: box ? box.lines : [], more: box ? box.more : 0, detail: detail || null }
        : null,
      changed: true,
    };
  });

  // STEP 5a: the venue's rate card on its store, one rule per payment type.
  // NO NUMBERS leave this screen (10 Sep 2026): the server applies the card
  // as it resolves (venue, else platform default) and refuses in plain words
  // naming any tier with no price.
  const setSplit = () => act('split', async () => {
    // A rate above the usual limit is refused once (over_limit) and said in
    // plain words under the table; pressing Apply again sends over_limit.
    const confirmOver = !!splitOver;
    const r = await callAdmin('set_split', { environment: target, ...(confirmOver ? { over_limit: true } : {}) });
    if (r?.ok === false) {
      if (r.over_limit && !confirmOver) {
        setSplitOver({ lines: lines(r.lines).length ? lines(r.lines) : [str(r.error)] });
        setOpenId('payouts');
        return { stop: true };
      }
      setSplitOver(null);
      setProblem({ text: str(r.error) || 'The rates could not be applied on Adyen.', detail: str(r.detail) || null });
      return { stop: true };
    }
    setSplitOver(null);
    return {
      notice: {
        text: 'Adyen holds these rates now.',
        line: str(r.line) || null,
        ids: [{ label: 'Rates on Adyen', value: str(r.splitConfigurationId) }, { label: 'Where the money lands', value: str(r.balanceAccountId) }],
      },
      problem: str(r.warning) ? { text: 'It is done. The server said something else as well.', tone: 'warn', detail: str(r.warning) } : null,
      changed: true,
    };
  });

  // STEP 5a, Edit rates: the same four row editor Processing uses, reading
  // and saving the venue rate card through payments-admin adyen_pricing. The
  // flow reads the venue again after a save so the table and the step move.
  const openRates = () => act('rates_read', async () => {
    if (!callPayments) return { stop: true };
    const r = await callPayments('adyen_pricing', { location_id: locId });
    const value = cardToState(r?.account?.rate_card);
    setRateEdit({ value, saved: value, defaults: r?.defaults || {}, account: r?.account || {}, ready: r?.rate_card_ready !== false, overLimit: null });
    setOpenId('payouts');
    return { stop: true };
  });
  // Save: a value that can never be right is said under the editor and never
  // sent; a value above the usual limit asks once (Save again keeps it); the
  // card the editor OPENED rides as expected_rate_card, so a card changed
  // meanwhile (Processing, another admin) is never overwritten.
  const saveRates = () => act('rates', async () => {
    if (!callPayments || !rateEdit) return { stop: true };
    const card = stateToCard(rateEdit.value);
    const check = rateCardProblems(card);
    if (check.errors.length) return { stop: true };
    const confirmOver = Array.isArray(rateEdit.overLimit) && rateEdit.overLimit.length > 0;
    if (check.overLimit.length && !confirmOver) {
      setRateEdit((e) => (e ? { ...e, overLimit: check.overLimit.map((x) => x.text) } : e));
      return { stop: true };
    }
    let r;
    try {
      r = await callPayments('adyen_pricing', {
        set: true, location_id: locId, rate_card: card, expected_rate_card: stateToCard(rateEdit.saved),
        ...(confirmOver ? { over_limit: true } : {}),
      });
    } catch (e) {
      const d = e?.data || {};
      if (d.over_limit) {
        setRateEdit((x) => (x ? { ...x, overLimit: lines(d.lines).length ? lines(d.lines) : [str(d.error)] } : x));
        return { stop: true };
      }
      if (d.changed) {
        setRateEdit(null);
        return { problem: { text: 'The rates changed since you opened them. Open them again.', detail: null } };
      }
      if (d.invalid) return { stop: true, problem: { text: str(d.error) || 'The rates could not be saved.', detail: lines(d.lines).join(' ') || null } };
      throw e;
    }
    setRateEdit(null);
    return {
      notice: { text: 'The venue rates are saved.' },
      problem: str(r?.warning) ? { text: 'They are saved. The server said something else as well.', tone: 'warn', detail: str(r.warning) } : null,
      changed: true,
    };
  });

  // STEP 1, the balance platform id, typed ONCE per region (10 Sep 2026).
  // The server checks it at Adyen and keeps it; the reload that follows every
  // action is the lookup running again with it.
  const savePlatformId = () => act('platform', async () => {
    const v = bpDraft.trim();
    if (!v) return { stop: true };
    const r = await callAdmin('set_balance_platform', { balancePlatformId: v, environment: target });
    if (r?.ok === false) {
      setProblem({ text: str(r.error) || 'The Adyen platform name could not be saved.', detail: str(r.detail) || null });
      return { stop: true };
    }
    setBpDraft('');
    return {
      notice: { text: 'Saved. Looking for the venue now.', ids: [{ label: 'Adyen platform name', value: str(r.balancePlatformId) }] },
      changed: true,
    };
  });

  // STEPS 2 AND 3 IN ONE CLICK (link_all, 10 Sep 2026): the read found the
  // store and the business account and the row names neither, so ONE
  // adyen_link on the venue's own environment with the reference and both
  // ids the read found writes the store, the merchant, where the money
  // lands, the holder, the registered company, the business line, the bank
  // account and the flags. A row naming other ids answers 409 needs_relink:
  // the in page ask.
  const saveAll = (relink) => act('save_all', async () => {
    const storeId = str(state?.store?.id);
    const holderId = str(state?.holder?.id);
    if (!storeId || !holderId) return { stop: true };
    let r;
    try {
      const { storeId: _pickedStore, accountHolderId: _pickedHolder, ...pickRest } = pickRef.current;
      r = await callAdmin('adyen_link', { ...pickRest, ...(reference ? { reference } : {}), storeId, accountHolderId: holderId, environment: venueEnv, ...(relink ? { relink: true } : {}) });
    } catch (e) {
      if (e?.data?.needs_relink && !relink) {
        setAsk({ kind: 'relink_all', ...relinkStoreConfirmView(e.data) });
        setLiveTyped('');
        return { stop: true };
      }
      throw e;
    }
    if (r?.ok === false) throw new Error(r.error || 'the Adyen details were not saved');
    setAsk(null); setLiveTyped('');
    const box = goliveProblemBox(r.problems);
    const said = lines(r.warnings).filter((w) => !/^Linked with gaps/i.test(w) && w !== str(r.storeNeeded) && !isPlatformSettingsMissingWarning(w));
    const detail = [box?.detail, ...said].filter(Boolean).join('\n\n');
    return {
      notice: {
        text: r.unchanged ? 'The Adyen details were already on the venue.' : 'The Adyen details are saved on the venue.',
        ids: [
          { label: 'Payments location', value: storeId },
          { label: 'Adyen business account', value: holderId },
          { label: 'Where the money lands', value: str(r.patch?.balance_account_id) },
          { label: 'Registered company', value: str(r.patch?.legal_entity_id) },
        ],
      },
      problem: box || said.length
        ? { text: 'They are saved. Adyen said something else as well.', tone: 'warn', lines: box ? box.lines : [], more: box ? box.more : 0, detail: detail || null }
        : null,
      changed: true,
    };
  });

  // STEP 5b: the bank details link. It works once and for four minutes, so it
  // is shown the moment it exists, with Copy, and the flow does not reload
  // over it (a reload would hide it before it was sent).
  const sendBankLink = () => act('bank_link', async () => {
    const r = await callAdmin('onboarding_link', { environment: target });
    if (r?.ok === false) {
      setProblem({ text: str(r.error) || 'The bank details link could not be made.', detail: str(r.detail) || null });
      return { stop: true };
    }
    setBankLink({ url: str(r.url), expiresAt: str(r.expiresAt) });
    setOpenId('payouts');
    return { stop: true, problem: str(r.warning) ? { text: 'The link is ready. The server said something else as well.', tone: 'warn', detail: str(r.warning) } : null };
  });

  // STEP 5b: pay the venue out daily. Adyen's approval is read on the server
  // at the click, so a pending check answers as a plain line, never a failure.
  const payOutDaily = () => act('sweep', async () => {
    const r = await callAdmin('setup_sweep', { environment: target });
    if (r?.ok === false) {
      if (r.pending) return { notice: { text: str(r.error) || 'Adyen has not approved payouts for this venue yet.' } };
      setProblem({ text: str(r.error) || 'The daily payout could not be switched on.', detail: str(r.detail) || null });
      return { stop: true };
    }
    return {
      notice: {
        text: r.retargeted ? 'The daily payout now goes to the venue’s current bank.' : r.existed && !r.updated ? 'The venue was already paid out daily.' : 'The venue is paid out daily to its bank.',
        ids: [{ label: 'Daily payout', value: str(r.sweep?.id) }, { label: 'Bank account', value: str(r.transferInstrumentId) }],
      },
      problem: str(r.warning) ? { text: 'It is on. The server said something else as well.', tone: 'warn', detail: str(r.warning) } : null,
      changed: true,
    };
  });

  // STEP 5b: ask Adyen for the payout capability a holder was never asked
  // for. One click; Adyen then runs its checks and the flow reads the answer.
  const requestPayouts = () => act('request', async () => {
    const r = await callAdmin('request_payouts', { environment: target });
    if (r?.ok === false) {
      setProblem({ text: str(r.error) || 'Adyen could not be asked for payouts.', detail: str(r.detail) || null });
      return { stop: true };
    }
    return {
      notice: { text: r.allowed ? 'Adyen allows payouts for this venue.' : 'Adyen has been asked to allow payouts. It is checking the venue now.' },
      problem: str(r.warning) ? { text: 'Adyen was asked. The server said something else as well.', tone: 'warn', detail: str(r.warning) } : null,
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
  const typedWord = 'LIVE';
  const needsTyped = ask?.kind === 'golive' && target === 'live' && venueEnv !== 'live';
  const typedOk = !needsTyped || liveTyped.trim().toUpperCase() === typedWord;
  const askGo = () => (ask?.kind === 'relink_store' ? saveStore(true) : ask?.kind === 'relink_holder' ? saveHolder(true) : ask?.kind === 'relink_all' ? saveAll(true) : doGoLive(ask?.kind === 'relink'));

  // THE ADYEN PLATFORM NAME, typed once per region (10 Sep 2026). Drawn on
  // whichever step carries set_balance_platform (step 1 with nothing found,
  // step 2 when the store was found), and never on a step that says nothing
  // could be read.
  const platformBox = (
    <div style={{ maxWidth: 460 }}>
      <p style={S.say}>{PLATFORM_ID_LINE}</p>
      <label style={S.field}>
        <span style={S.fieldLabel}>Adyen platform name <span style={S.brack}>(balance platform)</span></span>
        <input
          style={{ ...S.input, ...S.mono }}
          value={bpDraft}
          placeholder="FranPOS_UK"
          onChange={(e) => setBpDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && bpDraft.trim() && !anyBusy) savePlatformId(); }}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div style={{ marginTop: 14 }}>
        <Primary busy={busy === 'platform'} disabled={!bpDraft.trim() || anyBusy} onClick={savePlatformId}>Save and find the venue</Primary>
      </div>
    </div>
  );

  // The business accounts Adyen holds for the code. On the step that carries
  // pick_holder (two carry the code) it is THE thing to do, with the one
  // primary; on step 1 otherwise it is a quiet choice.
  const holderPicker = (asPrimary) => (holderCandidates.length > 0 ? (
    <div style={{ marginTop: asPrimary ? 0 : 18, maxWidth: 520 }}>
      <label style={S.field}>
        <span style={S.fieldLabel}>{asPrimary ? 'Pick the business account for this venue' : `Or pick the business account from the ${holderCandidates.length} Adyen holds`}</span>
        <select style={S.input} value={pickedHolder} disabled={anyBusy} onChange={(e) => setPickedHolder(e.target.value)}>
          <option value="">Pick one</option>
          {holderCandidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
        </select>
      </label>
      <div style={{ marginTop: asPrimary ? 14 : 10 }}>
        {asPrimary
          ? <Primary busy={busy === 'holder'} disabled={!pickedHolder || anyBusy} onClick={applyHolderCandidate}>Use this business account</Primary>
          : (
            <Secondary busy={anyBusy} disabled={!pickedHolder} onClick={applyHolderCandidate}>
              {busy === 'holder' ? 'Reading it' : 'Use the business account I picked'}
            </Secondary>
          )}
      </div>
    </div>
  ) : null);

  // The rate editor's own checks, live: an impossible value is said under
  // the rows and Save waits for it.
  const editCheck = rateEdit ? rateCardProblems(stateToCard(rateEdit.value)) : { errors: [], overLimit: [] };

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
          <p style={S.lede}>Six steps. Do the open one, the rest follow.</p>
          <p style={{ ...S.lede, marginTop: 4 }}>
            {reference ? <>Looking for <span style={S.mono}>{reference}</span> on the {region} {target} account.</> : <>Looking on the {region} {target} account.</>}
          </p>
          {/* The settings table waiting on its migration is ONE short line
              here, not a long sentence inside the error box (9 Sep 2026). */}
          {state.platformSettingsMissing === true && <p style={{ ...S.lede, marginTop: 4 }}>{PLATFORM_SETTINGS_WAITING_LINE}</p>}
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
          // A save click (link_all, link_holder) keeps its own sentence and its
          // one primary: the capability lines go UNDER the button and Open
          // Adyen is not offered over it (10 Sep 2026). The platform name and
          // the holder picker speak for themselves too.
          const holderSave = step.action === 'link_all' || step.action === 'link_holder';
          const ownBox = step.action === 'set_balance_platform' || step.action === 'pick_holder';
          const capsSpeak = step.id === 'business_account' && caps.length > 0 && !holderSave && !ownBox;
          // Step 5: the ONE part whose button is the primary (the step's own
          // action, else the first part with something to press). Every other
          // part button is a secondary, and none is primary while the rate
          // editor is open (Save the rates is).
          const primaryPartId = step.id === 'payouts' && !rateEdit
            ? ((step.parts.find((p) => p.action && p.action === step.action) || step.parts.find((p) => !p.done && p.action))?.id ?? null)
            : null;
          // Same for the two accounts: the mismatch block says it once, in
          // plain words, with the two names as ids and a picker under them.
          const mismatchSpeaks = !!mismatch && (step.id === 'payments_location' || step.action === 'choose_merchant');
          // Step 5 speaks through its two parts, each with its own line and
          // button, so the step's own line (the first part that needs doing)
          // is only drawn on the collapsed row.
          const partsSpeak = step.id === 'payouts' && step.parts.length > 0;
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
                  {step.detail && !capsSpeak && !mismatchSpeaks && !partsSpeak && <p style={S.say}>{step.detail}</p>}
                  {capsSpeak && (
                    <div style={{ margin: '0 0 12px', maxWidth: MEASURE }}>
                      {caps.map((c) => (
                        <div key={c.name} style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 4, color: c.tone === 'bad' ? 'var(--red)' : 'var(--orn, #e8a020)' }}>
                          {c.text} <span style={S.brack}>({c.label})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {step.hint && !mismatchSpeaks && !partsSpeak && <p style={S.quiet}>{step.hint}</p>}
                  {mismatchSpeaks && mismatchBlock}

                  {/* ── 1. find the venue ── */}
                  {step.id === 'find_venue' && (
                    <>
                      {/* One line when THIS read found the venue by its
                          reference with nothing pasted, so the admin sees it
                          working. */}
                      {refSearch.foundLine && <p style={S.quiet}>{refSearch.foundLine}</p>}
                      {/* Three ways in, one at a time (10 Sep 2026):
                            no code       pasting the id is the only way forward
                            no platform   ONE input, the Adyen platform name,
                                          saved once per region, on whichever
                                          step carries set_balance_platform
                            known         "Find on Adyen", no box at all */}
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
                            <Primary busy={busy === 'paste'} disabled={!pastedLooksRight || anyBusy} onClick={applyPastedId}>Use this id</Primary>
                          </div>
                        </div>
                      ) : step.action === 'set_balance_platform' ? (
                        platformBox
                      ) : step.action === 'pick_holder' ? (
                        holderPicker(true)
                      ) : (
                        <Primary busy={busy === 'look'} disabled={anyBusy} onClick={() => act('look', async () => ({}))}>Find on Adyen</Primary>
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
                          {step.action !== 'pick_holder' && holderPicker(false)}
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
                          {/* ADVANCED, collapsed (10 Sep 2026): pasting an id
                              is the last resort, never the main path. */}
                          <div style={{ marginTop: 18 }}>
                            <Secondary busy={anyBusy} onClick={() => setAdvancedOpen((v) => !v)}>{advancedOpen ? 'Hide advanced' : 'Advanced'}</Secondary>
                            {advancedOpen && (
                              <div style={{ marginTop: 14, maxWidth: 460 }}>
                                <p style={S.quiet}>Last resort. Paste the venue’s Adyen id if it cannot be found by its code.</p>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
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
                              </div>
                            )}
                          </div>
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
                      {/* add_bp_key (9 Sep 2026): the Balance Platform refused
                          our key. The detail and hint above say the one thing;
                          Open Adyen is where the second credential is made, and
                          the secret it goes in rides as its own grey row. */}
                      {(step.action === 'open_adyen' || step.action === 'send_onboarding' || step.action === 'add_bp_key' || capsSpeak) && (
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Primary disabled={anyBusy} onClick={openAdyen}>Open Adyen</Primary>
                          <Secondary busy={anyBusy} onClick={() => act('look2', async () => ({}))}>{busy === 'look2' ? 'Checking' : 'Check again'}</Secondary>
                        </div>
                      )}
                      {step.action === 'find_venue' && (
                        <Primary busy={busy === 'look'} disabled={anyBusy} onClick={() => act('look', async () => ({}))}>Look again</Primary>
                      )}
                      {/* The business accounts could not be searched until the
                          Adyen platform name is known, or two carry the code:
                          the one thing to do is on THIS step (10 Sep 2026). */}
                      {step.action === 'set_balance_platform' && platformBox}
                      {step.action === 'pick_holder' && holderPicker(true)}
                      {/* link_holder (9 Sep 2026): Adyen holds the business
                          account, the venue row does not name it yet. ONE
                          button, and it carries the store too. */}
                      {step.action === 'link_holder' && !ask && (
                        <Primary busy={busy === 'save_holder'} disabled={anyBusy || !str(state.holder?.id)} onClick={() => saveHolder(false)}>Save it on the venue</Primary>
                      )}
                      {/* link_all (10 Sep 2026): the store AND the business
                          account were found and the row names neither. ONE
                          click saves every id. */}
                      {step.action === 'link_all' && !ask && (
                        <Primary busy={busy === 'save_all'} disabled={anyBusy || !str(state.holder?.id) || !str(state.store?.id)} onClick={() => saveAll(false)}>Save the Adyen details on the venue</Primary>
                      )}
                      {/* What Adyen is still checking, UNDER the one save click,
                          never an Open Adyen primary over it (10 Sep 2026). */}
                      {holderSave && caps.length > 0 && (
                        <div style={{ margin: '14px 0 0', maxWidth: MEASURE }}>
                          {caps.map((c) => (
                            <div key={c.name} style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 4, color: c.tone === 'bad' ? 'var(--red)' : 'var(--orn, #e8a020)' }}>
                              {c.text} <span style={S.brack}>({c.label})</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ marginTop: 16 }}>
                        {/* The one value ServOS acts on, so it is body size,
                            not the 13px of a reference id. The hint above
                            points at it ("the setting below"). */}
                        {step.action === 'add_bp_key' && <IdLine big label="Server setting" value={str(state.balancePlatformKey?.secret)} />}
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

                      {/* link_store (9 Sep 2026): Adyen holds the store, the
                          venue row does not name it yet. ONE button. */}
                      {!mismatch && step.action === 'link_store' && !ask && (
                        <Primary busy={busy === 'save_store'} disabled={anyBusy || !str(state.store?.id)} onClick={() => saveStore(false)}>Save it on the venue</Primary>
                      )}
                      {!mismatch && step.action === 'link_all' && !ask && (
                        <Primary busy={busy === 'save_all'} disabled={anyBusy || !str(state.holder?.id) || !str(state.store?.id)} onClick={() => saveAll(false)}>Save the Adyen details on the venue</Primary>
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

                  {/* ── 5. card rates and payouts: two parts ── */}
                  {step.id === 'payouts' && step.parts.map((part) => {
                    const pt = CHIP[part.chip.tone] || CHIP.idle;
                    // ONE primary in the step (primaryPartId): this part's button
                    // is a Primary only when it is that part.
                    const isNext = part.id === primaryPartId;
                    const Btn = isNext ? Primary : Secondary;
                    const btnBusy = (key) => (isNext ? busy === key : anyBusy);
                    return (
                      <div key={part.id} style={{ margin: '0 0 22px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{part.title}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: pt.bg, color: pt.fg, border: `1px solid ${pt.bd}` }}>{part.chip.label}</span>
                        </div>
                        {part.detail && <p style={S.say}>{part.detail}</p>}
                        {part.hint && part.id !== 'split' && <p style={S.quiet}>{part.hint}</p>}

                        {/* 5a. THE CARD RATES (10 Sep 2026): the two plain
                            sentences, the four row table, then ONE primary:
                            Apply these rates on Adyen (set_split, no numbers)
                            or Edit rates when a tier has no price. Edit rates
                            opens the same editor Processing uses. */}
                        {part.id === 'split' && ratesKnown && !rateEdit && (
                          <>
                            {/* The venue rates could not be read: the numbers
                                would be a fallback, so no table is drawn. */}
                            {rates.readFailed !== true && (
                              <>
                                <p style={S.say}>{RATES_LEDE[0]}</p>
                                <p style={S.quiet}>{RATES_LEDE[1]}</p>
                                <RatesTable rows={rateRows} />
                              </>
                            )}
                            {/* A rate above the usual limit asked once: the
                                sentence here, and Apply again sends it. */}
                            {splitOver && part.action === 'set_split' && (
                              <div style={{ margin: '14px 0 0', maxWidth: MEASURE }}>
                                {splitOver.lines.map((l) => <p key={l} style={{ ...S.say, color: 'var(--orn, #e8a020)', margin: '0 0 6px' }}>{l}</p>)}
                                <p style={S.quiet}>Press Apply again to use these rates.</p>
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
                              {part.action === 'set_split' && (
                                <Btn busy={btnBusy('split')} disabled={anyBusy} onClick={setSplit}>{splitOver ? 'Apply these rates anyway' : 'Apply these rates on Adyen'}</Btn>
                              )}
                              {part.action === 'edit_rates' && callPayments && (
                                <Btn busy={btnBusy('rates_read')} disabled={anyBusy} onClick={openRates}>Edit rates</Btn>
                              )}
                              {part.action === 'check_rates' && (
                                <Btn busy={btnBusy('look5')} disabled={anyBusy} onClick={() => act('look5', async () => ({}))}>Check again</Btn>
                              )}
                              {part.action !== 'edit_rates' && callPayments && rates.readFailed !== true && (
                                <Secondary busy={anyBusy} onClick={openRates}>{busy === 'rates_read' ? 'Reading the rates' : 'Edit rates'}</Secondary>
                              )}
                              {part.done && (
                                <Secondary busy={anyBusy} onClick={() => act('look5', async () => ({}))}>{busy === 'look5' ? 'Checking' : 'Check again'}</Secondary>
                              )}
                            </div>
                          </>
                        )}
                        {part.id === 'split' && rateEdit && (
                          <div style={{ maxWidth: 640 }}>
                            <p style={S.say}>Blank means the platform default applies.</p>
                            <RateCardRows
                              big
                              value={rateEdit.value}
                              onChange={(v) => setRateEdit((e) => ({ ...e, value: v, overLimit: null }))}
                              fallbackFor={rateFallback}
                              currency={str(rates.currency) || 'GBP'}
                            />
                            {editCheck.errors.length > 0 && (
                              <div style={{ marginTop: 10, maxWidth: MEASURE }}>
                                {editCheck.errors.map((e) => <p key={e.text} style={{ ...S.say, color: 'var(--red)', margin: '0 0 6px' }}>{e.text}</p>)}
                              </div>
                            )}
                            {Array.isArray(rateEdit.overLimit) && rateEdit.overLimit.length > 0 && (
                              <div style={{ marginTop: 10, maxWidth: MEASURE }}>
                                {rateEdit.overLimit.map((l) => <p key={l} style={{ ...S.say, color: 'var(--orn, #e8a020)', margin: '0 0 6px' }}>{l}</p>)}
                                <p style={S.quiet}>Press Save again to keep it.</p>
                              </div>
                            )}
                            {rateEdit.ready === false && (
                              <div style={{ marginTop: 10 }}>
                                <p style={S.quiet}>Rates cannot be saved yet. One database update is waiting on ServOS.</p>
                                <IdLine label="Database update" value="20260821b_adyen_rate_card.sql" />
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
                              <Primary busy={busy === 'rates'} disabled={anyBusy || rateEdit.ready === false || editCheck.errors.length > 0 || cardsEqual(rateEdit.value, rateEdit.saved)} onClick={saveRates}>Save the rates</Primary>
                              <Secondary busy={anyBusy} onClick={() => setRateEdit(null)}>Cancel</Secondary>
                            </div>
                          </div>
                        )}
                        {part.id === 'split' && (
                          <div style={{ marginTop: 12 }}>
                            <IdLine label="Rates on Adyen (split configuration)" value={state.store?.splitConfigurationId} />
                            <IdLine label={<>{term('money')}</>} value={state.row?.balance_account_id || state.balanceAccount?.id} />
                            <IdLine label="ServOS account (liable balance account)" value={rates.liableBalanceAccountId} />
                          </div>
                        )}

                        {/* 5b. the payouts: the link, the daily payout, or a check */}
                        {part.id === 'payout' && part.action === 'send_bank_link' && !bankLink && (
                          <Btn busy={btnBusy('bank_link')} disabled={anyBusy} onClick={sendBankLink}>Send the bank details link</Btn>
                        )}
                        {part.id === 'payout' && bankLink && (
                          <div style={{ margin: '0 0 14px' }}>
                            <IdLine big label="Bank details link" value={bankLink.url} />
                            <p style={{ ...S.say, marginTop: 8 }}>Send this to the venue owner. They add the bank account and finish identity checks on Adyen.</p>
                            <p style={S.quiet}>It works once and for 4 minutes. Press the button again for a new one.</p>
                            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                              <Secondary busy={anyBusy} onClick={sendBankLink}>{busy === 'bank_link' ? 'Making a new link' : 'New link'}</Secondary>
                              <Secondary busy={anyBusy} onClick={() => { setBankLink(null); act('look5', async () => ({})); }}>{busy === 'look5' ? 'Checking' : 'Check again'}</Secondary>
                            </div>
                          </div>
                        )}
                        {part.id === 'payout' && part.action === 'setup_sweep' && (
                          <Btn busy={btnBusy('sweep')} disabled={anyBusy} onClick={payOutDaily}>Pay out daily</Btn>
                        )}
                        {part.id === 'payout' && part.action === 'check_payouts' && (
                          <Btn busy={btnBusy('look5')} disabled={anyBusy} onClick={() => act('look5', async () => ({}))}>Check again</Btn>
                        )}
                        {part.id === 'payout' && part.action === 'request_payouts' && (
                          <Btn busy={btnBusy('request')} disabled={anyBusy} onClick={requestPayouts}>Ask Adyen to allow payouts</Btn>
                        )}
                        {part.id === 'payout' && part.action === 'open_adyen' && (
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Btn busy={isNext ? false : anyBusy} disabled={anyBusy} onClick={openAdyen}>Open Adyen</Btn>
                            <Secondary busy={anyBusy} onClick={() => act('look5', async () => ({}))}>{busy === 'look5' ? 'Checking' : 'Check again'}</Secondary>
                          </div>
                        )}
                        {part.id === 'payout' && part.done && (
                          <Secondary busy={anyBusy} onClick={() => act('look5', async () => ({}))}>{busy === 'look5' ? 'Checking' : 'Check again'}</Secondary>
                        )}
                        {part.id === 'payout' && (
                          <div style={{ marginTop: 12 }}>
                            <IdLine label="Bank account (transfer instrument)" value={state.legalEntity?.transferInstrumentId || state.row?.transfer_instrument_id} />
                            <IdLine label="Daily payout (sweep)" value={state.payouts?.sweep?.id} />
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* ── 6. card readers ── */}
                  {step.id === 'readers' && (
                    <>
                      <p style={S.quiet}>
                        A {term('reader', { lower: true })} is added and put on a till in the venue&rsquo;s own Back Office, under Hardware, Card readers.
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
                          {readers.map((r) => <IdLine key={r.poiid} label={str(r.label) || 'Card reader'} value={r.poiid} />)}
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
              {ask.kind === 'relink' ? `Link ${name} again?`
                : ask.kind === 'relink_store' ? `Replace the payments location on ${name}?`
                : ask.kind === 'relink_holder' ? `Replace the business account on ${name}?`
                : ask.kind === 'relink_all' ? `Replace the Adyen details on ${name}?`
                : `Turn on live payments for ${name}?`}
            </h4>
            {ask.lines.map((l, i) => <p key={i} style={S.panelLine}>{l}</p>)}
            {/* The ids a replacement touches, now and after, as grey rows
                (relinkStoreConfirmView): never inside the lines above. */}
            {Array.isArray(ask.ids) && ask.ids.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {ask.ids.map((x) => <IdLine key={x.label} label={x.label} value={x.value} />)}
              </div>
            )}
            {needsTyped && (
              <div style={{ marginTop: 16, maxWidth: 320 }}>
                <label style={S.field}>
                  <span style={{ ...S.fieldLabel, color: 'var(--t1)' }}>Type {typedWord} to confirm.</span>
                  <input
                    style={{ ...S.input, ...S.mono, letterSpacing: '.1em' }}
                    value={liveTyped}
                    onChange={(e) => setLiveTyped(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && typedOk && !anyBusy) askGo(); }}
                    placeholder={typedWord}
                    autoFocus
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 18 }}>
              <Primary
                busy={busy === 'golive' || busy === 'save_store' || busy === 'save_holder' || busy === 'save_all'}
                disabled={!typedOk || anyBusy}
                live
                onClick={askGo}
              >
                {ask.kind === 'relink' ? 'Link it again' : ask.kind === 'relink_store' || ask.kind === 'relink_holder' ? 'Replace it' : ask.kind === 'relink_all' ? 'Replace them' : 'Turn on live payments'}
              </Primary>
              <Secondary busy={anyBusy} onClick={() => { setAsk(null); setLiveTyped(''); }}>Not now</Secondary>
            </div>
          </div>
        )}

        {/* WHAT HAPPENED, in one place under the steps so it never vanishes
            with the step that caused it, and so an Adyen refusal the read
            answered 200 with can never look like "nothing found". */}
        {(notice || problem || loadProblem || problemBox) && (
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
            {/* A note on a write that WENT THROUGH carries tone 'warn'; a
                failure stays red. */}
            <Problem problem={problem} tone={problem?.tone || 'bad'} />
            {loadProblem && <Problem problem={loadProblem} tone="warn" />}
            {/* At most three plain lines, the raw answers behind Show detail,
                and nothing the steps already say (9 Sep 2026). */}
            {problemBox && <Problem tone="warn" problem={problemBox} />}
          </div>
        )}
      </div>
    </div>
  );
}
