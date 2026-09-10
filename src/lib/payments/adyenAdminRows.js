/**
 * adyenAdminRows.js: the admin portal's Processing list, as pure shape work.
 * No network, no Supabase, no React.
 *
 * WHY (owner rules, 8 Sep 2026): the Processing list must scale to many
 * customers, so each venue is ONE compact row (name, venue code, region chip,
 * environment chip, then Linked, Holder, KYC and Payouts chips) derived from
 * its merchant_adyen_accounts row, and a search box filters by name, code or
 * slug. The Link to Adyen block shows what a lookup found and what a link
 * wrote in plain rows. Everything that decides a label or a colour lives
 * here so it is testable (adyenAdminRows.test.js).
 *
 * Chip tones (the owner's palette): live red, test grey, ok green, missing
 * amber; 'bad' (red) is a rejected or invalid KYC, 'muted' (grey) says
 * nothing is known.
 */

import { adyenEnvFromRow, adyenRegionFromRow } from './adyenEnv.js';
import { worstVerificationStatus, LINK_ID_FIELDS, storeStillNeeded, conflictsMoveMoney } from './adyenLink.js';
import { registrationLines } from './adyenOrigins.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const lower = (v) => str(v).toLowerCase();

// Readable names for the ids a link writes, in LINK_ID_FIELDS order.
export const LINK_FIELD_LABELS = Object.freeze({
  merchant_account: 'merchant account',
  store_id: 'store',
  split_profile_id: 'split configuration',
  balance_account_id: 'balance account',
  account_holder_id: 'account holder',
  legal_entity_id: 'legal entity',
  business_line_id: 'business line',
  transfer_instrument_id: 'bank account',
});

// The KYC chip from the row's verification_status snapshot. Both writers
// (adyen_link's buildLinkPatch and adyen-onboard's status_sync) store
// { verificationStatus?, accountHolderStatus?, capabilities: { name: {
// verificationStatus, allowed, ... } } }; the worst capability status wins
// when the top level one is absent. With no snapshot at all the row's
// receive_payments_ok is the only truth there is.
export function kycState(row) {
  const r = isObj(row) ? row : {};
  const vs = isObj(r.verification_status) ? r.verification_status : null;
  let status = null;
  if (vs) {
    status = lower(vs.verificationStatus) || null;
    if (!status && isObj(vs.capabilities)) {
      status = worstVerificationStatus(Object.values(vs.capabilities).map((c) => (isObj(c) ? c.verificationStatus : null)));
    }
  }
  if (status === 'valid') return { state: 'ok', tone: 'ok', label: 'KYC ok' };
  if (status === 'pending') return { state: 'pending', tone: 'missing', label: 'KYC pending' };
  if (status === 'invalid' || status === 'rejected') return { state: 'bad', tone: 'bad', label: `KYC ${status}` };
  if (r.receive_payments_ok === true) return { state: 'ok', tone: 'ok', label: 'Payments ok' };
  if (r.account_holder_id) return { state: 'unknown', tone: 'missing', label: 'KYC unknown' };
  return { state: 'missing', tone: 'missing', label: 'No KYC' };
}

// Everything a compact Adyen row shows, from the merchant_adyen_accounts row
// (null when the venue has none) and the platform location (its currency
// is the region fallback). Chips carry { tone, label, title }.
export function adyenVenueStatus(row, location) {
  const r = isObj(row) ? row : null;
  const region = adyenRegionFromRow(r, location);
  const environment = adyenEnvFromRow(r);
  const live = environment === 'live';
  // Linked = an Adyen store is mapped on the row's environment (the thing a
  // payment names); Holder = the account holder is known (KYC and payouts
  // hang off it). A plain merchant venue (store, no Balance Platform) is
  // linked without a holder, so the two are separate chips (8 Sep 2026:
  // 'Linked' used to need the holder and read 'Not linked' after a link).
  const linked = !!str(r?.store_id);
  const holder = !!str(r?.account_holder_id);
  const store = linked;
  const kyc = kycState(r);
  // PAID OUT (9 Sep 2026): Adyen allows payouts (payouts_ok, the capability)
  // AND a daily push sweep to the venue's bank exists (payout_sweep_id). A
  // row read before the payout_sweep_id column exists (the migration
  // 20260909b has not run, so the key is absent) reads the capability alone,
  // as it always did, and says so in the title.
  const allowed = r?.payouts_ok === true;
  const sweepKnown = !!r && 'payout_sweep_id' in r;
  const sweep = sweepKnown ? str(r.payout_sweep_id) : '';
  const payouts = allowed && (!sweepKnown || !!sweep);
  const ids = {};
  for (const k of LINK_ID_FIELDS) {
    const v = str(r?.[k]);
    if (v) ids[k] = v;
  }
  return {
    hasRow: !!r,
    region,
    environment,
    live,
    linked,
    holder,
    store,
    kyc,
    payouts,
    ids,
    chips: {
      region: { tone: 'muted', label: region, title: region === 'US' ? 'United States Adyen account' : 'United Kingdom Adyen account (EU data centre)' },
      environment: live
        ? { tone: 'live', label: 'LIVE', title: 'Live, real money at this venue' }
        : { tone: 'test', label: 'Test cards', title: 'Test cards only at this venue' },
      linked: linked
        ? { tone: 'ok', label: 'Linked', title: `Store ${ids.store_id} on ${environment}` }
        : { tone: 'missing', label: 'Not linked', title: 'No Adyen store is mapped. Use Link to Adyen.' },
      holder: holder
        ? { tone: 'ok', label: 'Holder', title: `Account holder ${ids.account_holder_id}` }
        : { tone: 'missing', label: 'No holder', title: 'No account holder is known, so KYC and payouts cannot be read. Link to Adyen pulls it from the store\'s balance account.' },
      kyc: { tone: kyc.tone, label: kyc.label, title: 'From the last verification snapshot Adyen gave' },
      // PAID OUT (9 Sep 2026): Adyen allows payouts AND a daily push to the
      // venue's bank exists (the go live flow's step 5 sets both up).
      payouts: payouts
        ? { tone: 'ok', label: 'Payouts', title: sweepKnown ? `Adyen allows payouts and the venue is paid out to its bank daily (sweep ${sweep})` : 'Adyen allows payouts to the venue bank' }
        : allowed
          ? { tone: 'missing', label: 'No payouts', title: 'Adyen allows payouts, but the daily payout is not switched on yet. See step 5 of the go live flow.' }
          : { tone: 'missing', label: 'No payouts', title: 'The venue is not paid out yet: the bank account, Adyen approval or the daily payout is missing. See step 5 of the go live flow.' },
    },
  };
}

// The Stripe row's chips, from the merchant_stripe_accounts row (msa).
export function stripeVenueStatus(msa) {
  const m = isObj(msa) ? msa : null;
  const status = !m
    ? { tone: 'missing', label: 'Not linked', title: 'No Stripe account is linked' }
    : m.charges_enabled
      ? { tone: 'ok', label: 'Charges enabled', title: `Stripe ${m.stripe_account_id ?? ''}` }
      : { tone: 'missing', label: 'Onboarding incomplete', title: 'Stripe has not enabled charges yet' };
  return { linked: !!m, status };
}

// Search: every whitespace separated token must appear in the name, the
// venue code, the slug or the company name (case insensitive). An empty
// query matches everything.
export function matchesVenueSearch(venue, query) {
  const tokens = lower(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const v = isObj(venue) ? venue : {};
  const hay = [v.name, v.venue_code, v.online_slug, v.company, v.id].map(lower).join(' ');
  return tokens.every((t) => hay.includes(t));
}

// One line per Adyen object a lookup found: [{ key, label, value, detail,
// tone }]. Only the pieces the chain reached are listed, so a gap shows as
// an absence, and the errors and notes (separate lists on the lookup) say why.
export function lookupRows(lookup) {
  const l = isObj(lookup) ? lookup : {};
  const rows = [];
  const s = isObj(l.store) ? l.store : null;
  if (s) {
    const addr = isObj(s.address) ? [s.address.line1, s.address.city, s.address.postalCode].map(str).filter(Boolean).join(', ') : '';
    rows.push({
      key: 'store', label: 'Store', value: str(s.id),
      detail: [s.reference ? `reference ${s.reference}` : '', s.status || '', s.description ? `"${s.description}"` : '', addr].filter(Boolean).join(' · '),
      tone: s.status === 'active' ? 'ok' : 'missing',
    });
    if (s.splitConfigurationId || l.splitConfigurationId) {
      rows.push({ key: 'split', label: 'Split configuration', value: str(l.splitConfigurationId || s.splitConfigurationId), detail: 'commission rules on the store', tone: 'ok' });
    }
  }
  const ba = isObj(l.balanceAccount) ? l.balanceAccount : null;
  if (ba) {
    rows.push({
      key: 'balance', label: 'Balance account', value: str(ba.id),
      detail: [ba.status || '', ba.currency || '', ba.source === 'account_holder' ? 'from the account holder, not the store' : 'named by the store'].filter(Boolean).join(' · '),
      tone: ba.status && ba.status !== 'active' ? 'missing' : 'ok',
    });
  }
  const ah = isObj(l.accountHolder) ? l.accountHolder : null;
  if (ah) {
    rows.push({
      key: 'holder', label: 'Account holder', value: str(ah.id),
      detail: [ah.status || '', ah.reference ? `reference ${ah.reference}` : ''].filter(Boolean).join(' · '),
      tone: ah.status && ah.status !== 'active' ? 'missing' : 'ok',
    });
  }
  const le = isObj(l.legalEntity) ? l.legalEntity : null;
  if (le) {
    rows.push({
      key: 'legal', label: 'Legal entity', value: str(le.id),
      detail: [le.name || '', le.type || '', le.status ? `verification ${le.status}` : '', le.transferInstrumentId ? `bank account ${le.transferInstrumentId}` : 'no bank account yet'].filter(Boolean).join(' · '),
      tone: le.status === 'valid' ? 'ok' : le.status === 'invalid' || le.status === 'rejected' ? 'bad' : 'missing',
    });
  }
  const caps = ah && isObj(ah.capabilities) ? ah.capabilities : null;
  if (caps) {
    const parts = [
      `receive payments ${caps.receiveOk ? 'allowed' : 'not allowed'}`,
      `payouts ${caps.payoutsOk ? 'allowed' : 'not allowed'}`,
      caps.verificationStatus ? `verification ${caps.verificationStatus}` : 'no verification status',
    ];
    rows.push({
      key: 'capabilities', label: 'Capabilities', value: parts.join(', '),
      detail: Array.isArray(caps.problems) && caps.problems.length ? caps.problems.join('; ') : '',
      tone: caps.receiveOk && caps.payoutsOk ? 'ok' : caps.verificationStatus === 'rejected' || caps.verificationStatus === 'invalid' ? 'bad' : 'missing',
    });
  }
  return rows;
}

// What a link would do, as one sentence, from the lookup answer's plan
// ({ kind, reason, diff }) and its environments.
export function planLine(answer) {
  const a = isObj(answer) ? answer : {};
  const plan = isObj(a.plan) ? a.plan : null;
  if (!plan) return null;
  const changed = Array.isArray(plan.diff?.changed) ? plan.diff.changed : [];
  const names = changed.map((k) => LINK_FIELD_LABELS[k] || k);
  if (plan.kind === 'noop') return { tone: 'ok', text: plan.reason || 'Already linked to these ids. Nothing to write.' };
  if (plan.kind === 'refuse') return { tone: 'missing', text: plan.reason || 'Linking needs a confirmed relink.' };
  const write = names.length ? `Will write ${names.join(', ')}.` : 'Will write the ids.';
  if (plan.kind === 'flip') {
    return { tone: a.environment === 'live' ? 'live' : 'test', text: `${write} Switches the venue from ${a.previous || 'test'} to ${a.environment || 'live'}${a.environment === 'live' ? ' (real money)' : ''}.` };
  }
  return { tone: 'ok', text: `${write} The venue stays on ${a.environment || 'live'}.` };
}

// The lines shown after adyen_link answered ok: the ids written, the
// environment change, the cleared setup, then origins and Apple Pay (each
// as the registrationLines list) and every warning. [{ tone, text, title? }]
export function linkResultLines(answer, venueName = 'The venue') {
  const a = isObj(answer) ? answer : {};
  const lines = [];
  if (a.unchanged) {
    lines.push({ tone: 'ok', text: a.message || 'Already linked to these ids. Nothing changed.' });
  } else {
    const patch = isObj(a.patch) ? a.patch : {};
    const ids = LINK_ID_FIELDS.filter((k) => str(patch[k])).map((k) => `${LINK_FIELD_LABELS[k] || k} ${str(patch[k])}`);
    lines.push({ tone: 'ok', text: ids.length ? `Linked ${a.reference || ''}: ${ids.join(', ')}.`.replace('Linked :', 'Linked:') : 'Linked.' });
    if (a.previous && a.environment && a.previous !== a.environment) {
      lines.push({
        tone: a.environment === 'live' ? 'live' : 'test',
        text: a.environment === 'live'
          ? `${venueName} now takes LIVE payments on the ${a.region || ''} account. Real cards are charged from now on.`.replace('the  account', 'the account')
          : `${venueName} is on test cards on the ${a.region || ''} account. Nobody is charged.`.replace('the  account', 'the account'),
      });
    }
    if (a.reprovisioned) {
      lines.push(a.stash_saved
        ? { tone: 'info', text: `The store and reader setup from ${a.previous || 'the previous environment'} was set aside and kept (${stashLine('', a.stash_saved)}). It comes back if the venue switches back.` }
        : { tone: 'missing', text: `The store and reader setup from ${a.previous || 'the previous environment'} was cleared. Register the card readers again.` });
    }
    const back = restoredLine(a.restored);
    if (back) lines.push({ tone: 'ok', text: `The ${a.environment || ''} setup kept earlier came back: ${back}.`.replace('The  setup', 'The setup') });
  }
  if (a.web_origins) lines.push({ tone: 'title', text: 'Web origins', items: registrationLines(a.web_origins) });
  if (a.apple_pay_domains) lines.push({ tone: 'title', text: 'Apple Pay domains', items: registrationLines(a.apple_pay_domains) });
  for (const w of Array.isArray(a.warnings) ? a.warnings : []) lines.push({ tone: 'missing', text: String(w) });
  return lines;
}

// One line for a kept setup (the fn's stash summary { store_id, ids,
// readers, stashed_at, region }, from env_stash, 8 Sep 2026): "test: store
// ST..., 2 card readers (kept 2026-09-08)". `env` may be '' for no prefix.
export function stashLine(env, summary) {
  const s = isObj(summary) ? summary : {};
  const bits = [];
  const ids = Number(s.ids) || 0;
  if (str(s.store_id)) bits.push(`store ${str(s.store_id)}`);
  else if (ids) bits.push(`${ids} account id${ids === 1 ? '' : 's'}`);
  const n = Number(s.readers) || 0;
  if (n) bits.push(`${n} card reader${n === 1 ? '' : 's'}`);
  const when = str(s.stashed_at).slice(0, 10);
  return `${str(env) ? `${str(env)}: ` : ''}${bits.length ? bits.join(', ') : 'nothing'}${when ? ` (kept ${when})` : ''}`;
}

// What a switch put back (the fn's restored answer { store_id, ids, readers:
// { platform, ops }, skipped }), '' when nothing came back.
export function restoredLine(restored) {
  const r = isObj(restored) ? restored : {};
  const bits = [];
  const ids = Array.isArray(r.ids) ? r.ids.length : 0;
  if (str(r.store_id)) bits.push(`store ${str(r.store_id)}`);
  else if (ids) bits.push(`${ids} account field${ids === 1 ? '' : 's'}`);
  const readers = isObj(r.readers) ? r.readers : {};
  const n = Math.max(Number(readers.ops) || 0, Number(readers.platform) || 0);
  if (n) bits.push(`${n} card reader${n === 1 ? '' : 's'}`);
  return bits.join(', ');
}

// ── THE THREE BLOCKS (8 Sep 2026, live screens) ──────────────────────────────
// A venue may be held at Adyen as an ACCOUNT HOLDER, as a STORE, or as both:
// on the live account SV-1007 is the account holder reference and no store
// carries it. So the panel shows THREE blocks, Account holder, Store, Legal
// entity, and each one either names what Adyen holds or says in plain words
// what is missing and what to do next. Nothing here decides anything: the
// function's own notes, errors and merchantMismatch line ride alongside.

// Readable names for the Adyen capabilities an account holder or legal entity
// carries. Anything not listed is split out of its camelCase name.
const CAPABILITY_LABELS = Object.freeze({
  receivePayments: 'receive payments',
  receiveFromPlatformPayments: 'receive platform payments',
  receiveFromBalanceAccount: 'receive from balance account',
  sendToTransferInstrument: 'pay out to a bank account',
  sendToBalanceAccount: 'send to balance account',
  issueCard: 'issue cards',
  useCard: 'use cards',
  withdrawFromAtm: 'withdraw from an ATM',
  getGrantOffers: 'capital offers',
});

function capabilityLabel(name) {
  const n = str(name);
  if (CAPABILITY_LABELS[n]) return CAPABILITY_LABELS[n];
  return n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase() || 'capability';
}

// One row per Adyen capability, so a BLOCKED one is visible instead of hiding
// inside a verification status. Takes the capability summary
// (summariseCapabilities: { byName, ... }) or a bare { name: entry } map.
//   allowed true                    → ok      (green)
//   requested, not allowed, pending → missing (amber, Adyen is still checking)
//   requested, not allowed          → bad     (red, this is the blocked one)
//   not requested                   → muted   (grey, nothing was asked for)
export function capabilityRows(capabilities) {
  const c = isObj(capabilities) ? capabilities : {};
  const byName = isObj(c.byName) ? c.byName : c;
  const rows = [];
  for (const [name, raw] of Object.entries(byName)) {
    if (!isObj(raw)) continue;
    const allowed = raw.allowed === true;
    const requested = raw.requested !== false;
    const status = lower(raw.verificationStatus) || null;
    const tone = allowed ? 'ok' : !requested ? 'muted' : status === 'pending' ? 'missing' : 'bad';
    const state = allowed ? 'allowed' : !requested ? 'not requested' : 'NOT ALLOWED';
    rows.push({
      key: name,
      name,
      label: capabilityLabel(name),
      allowed,
      requested,
      enabled: raw.enabled === true,
      verificationStatus: status,
      tone,
      text: `${capabilityLabel(name)}: ${state}${status ? ` · verification ${status}` : ''}${raw.enabled === false && allowed ? ' · disabled' : ''}`,
      problems: Array.isArray(raw.problems) ? raw.problems.length : 0,
    });
  }
  // The blocking ones first (red, then amber), then allowed, then unrequested.
  const order = { bad: 0, missing: 1, ok: 2, muted: 3 };
  return rows.sort((a, b) => (order[a.tone] ?? 4) - (order[b.tone] ?? 4) || a.label.localeCompare(b.label));
}

// A block's id rows, empty values dropped.
function idRows(pairs) {
  return pairs.filter(([, v]) => str(v)).map(([label, v]) => ({ label, value: str(v) }));
}

// The three blocks a lookup answer shows: [{ key, title, found, tone, rows,
// lines, capabilities }]. `lines` is what to do next when a piece is missing
// (or a caveat when it is there); `capabilities` is only on the holder block.
export function lookupBlocks(lookup) {
  const l = isObj(lookup) ? lookup : {};
  const store = isObj(l.store) && str(l.store.id) ? l.store : null;
  const ba = isObj(l.balanceAccount) && str(l.balanceAccount.id) ? l.balanceAccount : null;
  const ah = isObj(l.accountHolder) && str(l.accountHolder.id) ? l.accountHolder : null;
  const le = isObj(l.legalEntity) && str(l.legalEntity.id) ? l.legalEntity : null;
  const mismatch = isObj(l.merchantMismatch) ? l.merchantMismatch : null;
  const ref = str(l.reference) || 'this venue';

  // 1. Account holder (with its balance account: the money side)
  const holder = { key: 'holder', title: 'Account holder', found: !!ah, tone: 'missing', rows: [], lines: [], capabilities: [] };
  if (ah) {
    holder.rows = idRows([
      ['Account holder', ah.id],
      ['Reference', ah.reference],
      ['Status', ah.status],
      ['Balance platform', ah.balancePlatform],
      ['Balance account', ba ? ba.id : ''],
      ['Currency', ba ? ba.currency : ''],
    ]);
    const caps = isObj(ah.capabilities) ? ah.capabilities : null;
    holder.capabilities = capabilityRows(caps);
    const blocked = holder.capabilities.filter((c) => c.tone === 'bad');
    holder.tone = ah.status && ah.status !== 'active' ? 'missing' : blocked.length ? 'bad' : 'ok';
    if (ah.status && ah.status !== 'active') holder.lines.push({ tone: 'missing', text: `The account holder is ${ah.status} at Adyen, so nothing settles to it until Adyen makes it active.` });
    if (blocked.length) holder.lines.push({ tone: 'bad', text: `Adyen BLOCKS ${blocked.length === 1 ? 'this capability' : 'these capabilities'}: ${blocked.map((c) => c.label).join(', ')}. Clear the verification problems in the Adyen Customer Area (or send the venue its onboarding link) before promising it money.` });
    if (!ba) holder.lines.push({ tone: 'missing', text: 'No balance account could be chosen for the account holder, so payouts have nowhere to land. Check the account holder in the Adyen Customer Area.' });
    else if (ba.source === 'account_holder' && store) holder.lines.push({ tone: 'missing', text: `Balance account ${ba.id} came from the account holder, not from the store: the store's split configuration at Adyen does not name it, so payments do not split into it yet.` });
  } else {
    holder.lines.push({ tone: 'missing', text: `Adyen holds no account holder for ${ref}. Paste the account holder id (AH...) from the Adyen Customer Area, or check the balance platform the venue was onboarded on.` });
  }

  // 2. Store (what a card payment names)
  const block = { key: 'store', title: 'Store', found: !!store, tone: 'missing', rows: [], lines: [] };
  if (store) {
    block.rows = idRows([
      ['Store', store.id],
      ['Reference', store.reference],
      ['Status', store.status],
      ['Merchant account', store.merchantId],
      ['Split configuration', l.splitConfigurationId || store.splitConfigurationId],
      ['Balance account', store.balanceAccountId],
      ['Business line', Array.isArray(store.businessLineIds) ? store.businessLineIds[0] : ''],
    ]);
    block.tone = store.status === 'active' ? 'ok' : 'missing';
    if (store.status && store.status !== 'active') block.lines.push({ tone: 'missing', text: `The store is ${store.status} at Adyen: payments naming it are refused until Adyen makes it active.` });
    if (!store.balanceAccountId) block.lines.push({ tone: 'missing', text: 'The store carries no split configuration, so Adyen books its payments nowhere in particular. Create or link the split configuration to the venue’s balance account.' });
  } else {
    const needed = storeStillNeeded(l);
    block.lines.push({ tone: 'missing', text: needed || `No store carries the reference ${ref} on any merchant account this credential can see. Create it with this reference, or pick one of the stores listed below.` });
  }
  if (mismatch && str(mismatch.message)) block.lines.push({ tone: 'bad', text: str(mismatch.message) });

  // 3. Legal entity (the KYC truth and the bank account)
  const legal = { key: 'legal', title: 'Legal entity', found: !!le, tone: 'missing', rows: [], lines: [] };
  if (le) {
    legal.rows = idRows([
      ['Legal entity', le.id],
      ['Name', le.name],
      ['Type', le.type],
      ['Verification', le.status],
      ['Bank account', le.transferInstrumentId],
    ]);
    legal.tone = le.status === 'valid' ? 'ok' : le.status === 'invalid' || le.status === 'rejected' ? 'bad' : 'missing';
    if (!le.transferInstrumentId) legal.lines.push({ tone: 'missing', text: 'The legal entity has no bank account yet, so Adyen cannot pay the venue out. It adds one through its onboarding link.' });
    for (const p of Array.isArray(le.problems) ? le.problems : []) legal.lines.push({ tone: 'bad', text: str(p) });
  } else if (ah) {
    legal.lines.push({ tone: 'missing', text: 'The account holder names no legal entity, so there is no KYC to read. Adyen creates one when the venue is onboarded.' });
  } else {
    legal.lines.push({ tone: 'missing', text: 'The legal entity is read from the account holder, so the account holder is needed first.' });
  }

  return [holder, block, legal];
}

// The merchant picker for one environment, from the adyen_merchants answer
// ({ live: { configured, secret, merchantAccount, merchants, error }, test:
// { ... } }): the accounts the credential can see, the configured one marked,
// and the secret that names it. Options are plain { value, label }.
export function merchantPicker(answer, environment = 'live') {
  const a = isObj(answer) ? answer : {};
  const env = lower(environment) === 'test' ? 'test' : 'live';
  const side = isObj(a[env]) ? a[env] : {};
  const configured = str(side.merchantAccount) || null;
  const rows = Array.isArray(side.merchants) ? side.merchants.filter(isObj) : [];
  const options = rows.map((m) => {
    const id = str(m.id);
    const count = Number(m.storeCount);
    const bits = [
      str(m.name),
      str(m.status),
      Number.isFinite(count) && count >= 0 ? `${count} store${count === 1 ? '' : 's'}` : '',
      configured && id.toLowerCase() === configured.toLowerCase() ? 'the secret’s account' : '',
    ].filter(Boolean);
    return { value: id, label: [id, ...bits].join(' · '), configured: !!configured && id.toLowerCase() === configured.toLowerCase() };
  }).filter((o) => o.value);
  return {
    environment: env,
    configured,
    secret: str(side.secret) || null,
    error: str(side.error) || null,
    options,
  };
}

// A candidate store as one option label.
export function candidateLabel(c) {
  const x = isObj(c) ? c : {};
  return [x.reference || '(no reference)', x.description ? `"${x.description}"` : '', x.status && x.status !== 'active' ? `(${x.status})` : '', x.id].filter(Boolean).join(' · ');
}

// ── THE GUIDED FLOW (8 Sep 2026, OWNER FEEDBACK) ─────────────────────────────
// "we need this to be easier and better there is far too many words and too
// small we need a flow that supports someone doing this". So the admin portal
// no longer shows the dense lookup blocks: it shows SIX numbered steps, one
// open at a time, each with one sentence and one primary button
// (src/admin/components/AdyenGoLiveFlow.jsx). Everything that decides a
// title, a chip, which step is open or how an error reads lives here so it is
// testable and the screen only draws.
//
// The Adyen words stay available in small grey brackets on first use, and the
// plain words carry the meaning:
//   Adyen business account (account holder)
//   Where the money lands (balance account)
//   Registered company (legal entity)
//   Payments location (store)
//   Card machine (terminal)

export const GOLIVE_STEP_TITLES = Object.freeze({
  find_venue: 'Find the venue on Adyen',
  business_account: 'The venue’s Adyen business account',
  payments_location: 'The venue’s payments location',
  go_live: 'Turn on live payments',
  payouts: 'Payouts and commission',
  readers: 'Card readers',
});

// The two parts of the payouts step (9 Sep 2026), each its own line and
// button on the screen: the commission rule on the store, and the bank
// account, Adyen's approval and the daily payout.
export const GOLIVE_PART_TITLES = Object.freeze({
  split: 'Commission',
  payout: 'Payouts to the venue',
});

// The six ids, in order. The server answers all six (buildGoliveSteps); the
// order here is the screen's own so a missing or reordered answer still draws
// the same six rows.
const GOLIVE_ORDER = Object.freeze(['find_venue', 'business_account', 'payments_location', 'go_live', 'payouts', 'readers']);

// The state chip: Done green, To do grey, Needs attention amber, Blocked red.
const GOLIVE_CHIPS = Object.freeze({
  done: { label: 'Done', tone: 'ok' },
  todo: { label: 'To do', tone: 'idle' },
  attention: { label: 'Needs attention', tone: 'warn' },
  blocked: { label: 'Blocked', tone: 'bad' },
});

// The whole flow as the screen draws it: the six rows, which ONE is open
// (the first that is not done, unless the reader opened another), and the
// progress line at the top. openId is the row the reader clicked, or null.
// A step's `parts` (the payouts step) ride through in the same shape, each
// with its own title, chip and button.
export function goliveFlowView(state, openId = null) {
  const s = isObj(state) ? state : {};
  const answered = new Map((Array.isArray(s.steps) ? s.steps : []).filter(isObj).map((x) => [str(x.id), x]));
  const steps = GOLIVE_ORDER.map((id, i) => {
    const x = answered.get(id) || {};
    const st = GOLIVE_CHIPS[lower(x.state)] ? lower(x.state) : 'todo';
    const parts = (Array.isArray(x.parts) ? x.parts : []).filter(isObj).map((p) => {
      const ps = GOLIVE_CHIPS[lower(p.state)] ? lower(p.state) : 'todo';
      return {
        id: str(p.id),
        title: GOLIVE_PART_TITLES[str(p.id)] || str(p.id),
        state: ps,
        chip: GOLIVE_CHIPS[ps],
        done: ps === 'done',
        detail: str(p.detail) || null,
        hint: str(p.hint) || null,
        action: str(p.action) || null,
      };
    });
    return {
      id,
      number: i + 1,
      title: GOLIVE_STEP_TITLES[id],
      state: st,
      chip: GOLIVE_CHIPS[st],
      done: st === 'done',
      detail: str(x.detail) || null,
      hint: str(x.hint) || null,
      action: str(x.action) || null,
      parts,
      open: false,
    };
  });
  const picked = steps.find((x) => x.id === str(openId)) || null;
  // WHICH STEP OPENS BY ITSELF. Anything Adyen has BLOCKED comes first: the
  // flow cannot go past it. Otherwise the first step that is not done AND has
  // something to press, so a step that is only telling the owner something
  // ("Cards work. Payouts wait for Adyen.") is amber and the flow moves on
  // instead of parking them on work they cannot do today (8 Sep 2026: a
  // blocked payout held the whole flow at step 2 forever).
  // ONE EXCEPTION (9 Sep 2026, live screen): a step blocked on a SERVER SECRET
  // (add_bp_key, the Balance Platform key only ServOS can add) is work the
  // owner cannot do from this screen either, so a step with a click the owner
  // CAN make wins over it. The live screen parked the owner on step 2 with
  // "Open Adyen" while the one button that turns the list chip to Linked
  // ("Save it on the venue", step 3) sat behind a collapsed row.
  const serverOnly = (x) => x.action === 'add_bp_key';
  const next = steps.find((x) => x.state === 'blocked' && !serverOnly(x))
    || steps.find((x) => !x.done && x.action && !serverOnly(x))
    || steps.find((x) => x.state === 'blocked')
    || steps.find((x) => !x.done)
    || null;
  const open = picked || next;
  if (open) open.open = true;
  const doneCount = steps.filter((x) => x.done).length;
  const allDone = doneCount === steps.length;
  return {
    steps,
    openId: open ? open.id : null,
    doneCount,
    total: steps.length,
    allDone,
    progressLabel: allDone && !picked ? `All ${steps.length} steps done` : `Step ${open ? open.number : steps.length} of ${steps.length}`,
    progressPct: Math.round((doneCount / steps.length) * 100),
  };
}

// ── WHAT THE SCREEN SAYS ABOUT PROBLEMS (9 Sep 2026, OWNER FEEDBACK) ────────
// "just errors all over the place, I dont know whats happening". golive_state
// now answers `problems`: one plain line per distinct problem, with the raw
// Adyen answer in rawDetail (goliveProblems in adyenLink.js). The screen draws
// them in ONE amber box under the steps, at most PROBLEM_BOX_MAX_LINES lines,
// and never the two facts that have their own place on the screen:
//   bp_refused   the business account step says the one reason, once
//   mismatch     the mismatch block draws the two account names and a picker
//   no_code      step 1 says it word for word (set_venue_code), and Adyen was
//                never asked, so "Adyen did not answer everything" is untrue
// Null when nothing is left to say, so the box does not appear at all.
export const PROBLEM_BOX_MAX_LINES = 3;
export const PROBLEM_BOX_TEXT = 'Adyen did not answer everything, so what is on screen may not be the whole picture.';
//   foreign_balance_account  the store sends the rest of each sale to another
//                business account: step 5a says it and offers to set it again
export const PROBLEM_BOX_SKIP = Object.freeze(['bp_refused', 'mismatch', 'no_code', 'foreign_balance_account']);

export function goliveProblemBox(problems, { exclude = PROBLEM_BOX_SKIP } = {}) {
  const skip = new Set(Array.isArray(exclude) ? exclude.map(str) : []);
  const seen = new Set();
  const rows = [];
  for (const p of Array.isArray(problems) ? problems : []) {
    if (!isObj(p)) continue;
    const text = str(p.text);
    if (!text || skip.has(str(p.kind)) || seen.has(text)) continue;
    seen.add(text);
    rows.push({ kind: str(p.kind) || 'other', text, rawDetail: str(p.rawDetail) || null });
  }
  if (!rows.length) return null;
  const lines = rows.slice(0, PROBLEM_BOX_MAX_LINES);
  return {
    text: PROBLEM_BOX_TEXT,
    lines,
    more: rows.length - lines.length,
    // EVERY raw answer, including the ones past the third line, so nothing
    // Adyen said is lost: it just sits behind Show detail.
    detail: rows.map((r) => r.rawDetail).filter(Boolean).join('\n\n') || null,
  };
}

// The ONE short line at the top of the flow while the platform settings table
// waits on its migration (platformSettingsMissing). It used to be a long
// sentence naming the table and the migration file inside the error box.
export const PLATFORM_SETTINGS_WAITING_LINE = 'One database step is waiting on ServOS. Venues need their id pasted until it runs.';

// A capability Adyen has not allowed, in plain words: never the word Blocked
// on its own. Takes golive_state's capabilities (capabilityList's wire shape).
export function capabilityNotices(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => isObj(c) && c.blocked === true)
    .map((c) => {
      const pending = lower(c.verification) === 'pending';
      return {
        name: str(c.name),
        label: capabilityLabel(c.name),
        pending,
        text: pending ? 'Adyen is still checking this' : 'Adyen has not approved this yet',
        tone: pending ? 'missing' : 'bad',
      };
    });
}

// ── FINDING A VENUE BY ITS REFERENCE (8 Sep 2026) ───────────────────────────
// Adyen has no lookup by reference on the money side: account holders can only
// be listed under a balance platform id. So the FIRST venue on an account has
// to have its Adyen id pasted once, that read hands us the balance platform
// id, we keep it (adyen_platform_settings), and every venue after it is found
// by its reference on its own.
//
// The screen says which of those two it is in ONE line, and the paste box
// stops being the main path the moment the id is known:
//   known === false   the paste box IS the way in, with firstVenueLine above it
//   known === true    "Look again" is the primary and the paste box is a small
//                     secondary underneath
//   foundLine         set when THIS read found the venue by its reference with
//                     nothing pasted, so the admin sees it working
export function referenceSearchView(state) {
  const s = isObj(state) ? state : {};
  const known = s.balancePlatformKnown === true;
  const ref = str(s.reference) || str(isObj(s.venue) ? s.venue.code : '');
  return {
    known,
    pastePrimary: !known,
    firstVenueLine: known ? null : 'The first venue needs its Adyen id pasted once. After that we find venues by their reference on their own.',
    foundLine: lower(s.holderFoundBy) === 'reference'
      ? `${ref || 'This venue'} was found on Adyen by its reference. Nothing was pasted.`
      : null,
  };
}

// The merchant mismatch in plain words, with the two account names apart from
// the sentence so the screen can show them as ids and offer the picker (live,
// 8 Sep 2026: the secret names FranPOS_QSR_UK, the venue sits on FranPOS_UK).
export function mismatchView(mismatch) {
  const m = isObj(mismatch) ? mismatch : null;
  const theirs = str(m?.found) || null;
  const ours = str(m?.configured) || null;
  if (!theirs && !ours) return null;
  return {
    text: 'This venue is on a different Adyen account than the one we are set to use.',
    theirs,
    ours,
    secret: str(m.secret) || null,
    detail: str(m.message) || null,
  };
}

// One plain sentence for a failure, and the raw answer kept for the small
// "Show detail" toggle. `what` is what was being done, in plain words.
export function plainFailure(err, what = 'That did not work') {
  const e = isObj(err) ? err : {};
  const data = isObj(e.data) ? e.data : {};
  const raw = str(data.detail) || str(data.error) || str(e.message) || str(err);
  const status = Number(e.status) || null;
  // The kind is read from the error AND the detail: a refused scope answers
  // error 'scope_missing' with the role named in detail, and detail is what
  // Show detail keeps.
  const low = `${lower(data.error)} ${lower(raw)}`;
  const said = str(what).replace(/\.$/, '') || 'That did not work';
  let text;
  if (status === 403 || low.includes('servos admin only')) text = 'Only a ServOS super admin can do this. Sign in as one, then try again.';
  else if (low.includes('not authenticated')) text = 'You are signed out. Sign in again, then try once more.';
  else if (low.includes('scope_missing') || low.includes('management role') || low.includes('lacks management') || low.includes('lacks the management')) text = 'The Adyen key we use is missing a permission, so Adyen refused. Add the missing role to the key, then try again.';
  else if (low.includes('not configured') || low.includes('missing adyen') || low.includes('adyen_live') || low.includes('adyen_test')) text = 'The Adyen keys for this account are not on the server yet. Add them, then try again.';
  else if (low.includes('failed to fetch') || low.includes('networkerror') || low.includes('load failed')) text = 'The server could not be reached. Check the connection and try again.';
  else if (low.includes('timed out') || low.includes('timeout') || low.includes('aborted')) text = 'Adyen took too long to answer. Try again in a moment.';
  else if (low.includes('needs the venue address')) text = 'Adyen needs the street, town, postcode and phone number for a live venue. Fill all four in, then try again.';
  else if (low.includes('carry the reference')) text = 'More than one payments location already carries this code. Pick the right one in step 1 instead of making another.';
  else text = `${said}. Try again, and open Show detail to see what Adyen said.`;
  return { text, detail: raw || null };
}

// THE ONE CONFIRM before any write, built from an adyen_lookup answer: what
// the link does (going live: real money), a store that is not active, the
// stored ids it replaces, and what a move between test and live sets aside,
// keeps and puts back. Kept word for word from the dense panel it replaces
// (8 Sep 2026), because going live must always ask.
// The same content as ONE LINE PER CONSEQUENCE, for the in page panel that
// replaced window.confirm (8 Sep 2026: a native dialog rendered up to six
// paragraphs at the OS default size, on the one screen that decides whether
// real cards are charged). goLiveConfirmText joins them for anything that
// still wants a string.
export function goLiveConfirmLines(lookup, venueName = 'this venue') {
  const a = isObj(lookup) ? lookup : {};
  const l = isObj(a.lookup) ? a.lookup : {};
  const plan = isObj(a.plan) ? a.plan : {};
  const name = str(venueName) || 'this venue';
  const storeId = str(l.store?.id) || null;
  const status = lower(l.store?.status);
  const live = lower(a.environment) === 'live';
  const flips = str(a.previous) !== str(a.environment);
  const where = storeId ? ` and link it to payments location ${storeId}` : '';
  const lines = [];
  if (live) {
    lines.push(flips
      ? `Turn on live payments for ${name} on the ${str(a.region) || 'Adyen'} account${where}. Real cards are charged from then on.`
      : `Link ${name} on the ${str(a.region) || 'Adyen'} live account${storeId ? ` to payments location ${storeId}` : ''}.`);
  } else {
    lines.push(`Link ${name} on the ${str(a.region) || 'Adyen'} test account${storeId ? ` to payments location ${storeId}` : ''}.`);
  }
  if (!storeId) lines.push('Adyen holds no payments location for this venue yet, so cards still have nowhere to go. Create it in the next step.');
  const inactive = !!status && status !== 'active';
  if (inactive) lines.push(`The payments location is ${status.toUpperCase()} at Adyen, so it cannot take cards until Adyen makes it active.`);
  const conflicts = Array.isArray(plan.diff?.conflicts) ? plan.diff.conflicts : [];
  if (!flips && conflicts.length) {
    lines.push(`This REPLACES stored ids: ${conflicts.map((c) => `${LINK_FIELD_LABELS[c.field] || c.field} ${c.current} to ${c.next}`).join(', ')}.`);
  }
  if (flips) {
    const provisioned = Array.isArray(a.provisioned) ? a.provisioned : [];
    const readers = Number(a.readers) || 0;
    const bits = [provisioned.length ? 'the Adyen ids' : '', readers ? `${readers} card machine${readers === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (bits.length) {
      lines.push(a.keepsSetup
        ? `This sets aside the venue’s ${a.previous} setup (${bits.join(' and ')}). It is kept, and it comes back if you switch back.`
        : `This CLEARS the venue’s ${a.previous} setup (${bits.join(' and ')}). Register the card machines again afterwards.`);
    } else if (plan.kind === 'refuse' && plan.reason && !inactive) lines.push(str(plan.reason));
    const back = isObj(a.stashes) ? a.stashes[str(a.environment)] : null;
    if (back) lines.push(`The ${a.environment} setup kept earlier comes back too: ${stashLine('', back)}.`);
    if (a.stashWarning) lines.push(str(a.stashWarning));
  }
  return lines;
}

export function goLiveConfirmText(lookup, venueName = 'this venue') {
  return `${goLiveConfirmLines(lookup, venueName).join('\n\n')}\n\nContinue?`;
}

// The second confirm: the fn answered 409 needs_relink (the venue changed
// between the read and the click), with its own reason.
export function relinkConfirmLines(data) {
  const d = isObj(data) ? data : {};
  const lines = [str(d.error) || 'Adyen holds different ids for this venue now.'];
  if (d.keepsSetup === true && str(d.previous) && str(d.environment) && str(d.previous) !== str(d.environment)) {
    lines.push(`The venue’s ${d.previous} setup is kept, and it comes back if you switch back.`);
  }
  return lines;
}

export function relinkConfirmText(data, venueName = 'this venue') {
  const name = str(venueName) || 'this venue';
  return `${relinkConfirmLines(data).join('\n\n')}\n\nGo ahead and link ${name} again?`;
}

// THE "REPLACE IT" ASK for a found store the venue row already names
// differently (link_store answered 409 needs_relink, 9 Sep 2026). The fn's
// own reason is planLink's sentence with two to four ids and the database
// column names inside it (151 to 207 characters), exactly the "long code
// lines" the owner cannot read. So the panel gets plain lines under 120
// characters with NO id in them, and every id as its own grey row: the value
// on the venue now and the one after, per conflicting field, from
// plan.diff.conflicts. d.error stays in the audit log.
// The third line only when the replacement MOVES THE MONEY SIDE (a conflict
// on balance_account_id or account_holder_id): that is the only case the
// server clears the ids the read did not reach (relinkClear).
const RELINK_FIELD_LABELS = Object.freeze({
  store_id: 'Payments location',
  balance_account_id: 'Where the money lands',
  merchant_account: 'Adyen account',
  account_holder_id: 'Adyen business account',
  legal_entity_id: 'Registered company',
  split_profile_id: 'Split configuration',
  business_line_id: 'Business line',
  transfer_instrument_id: 'Bank account',
});

export function relinkStoreConfirmView(data) {
  const d = isObj(data) ? data : {};
  const plan = isObj(d.plan) ? d.plan : {};
  const conflicts = (isObj(plan.diff) && Array.isArray(plan.diff.conflicts) ? plan.diff.conflicts : []).filter(isObj);
  const fields = new Set(conflicts.map((c) => str(c.field)));
  const lines = [
    fields.has('store_id') || !fields.size ? 'The venue already names a different payments location.'
      : fields.has('merchant_account') ? 'The venue already names a different Adyen account.'
      : 'The venue already names different Adyen ids.',
    'Replacing it changes where card payments go.',
  ];
  if (conflictsMoveMoney(conflicts)) lines.push('Ids on the venue that this read did not reach are cleared.');
  const ids = [];
  for (const c of conflicts) {
    const label = RELINK_FIELD_LABELS[str(c.field)] || str(c.field) || 'Id';
    if (str(c.current)) ids.push({ label: `${label} now`, value: str(c.current) });
    if (str(c.next)) ids.push({ label: `${label} after`, value: str(c.next) });
  }
  return { lines, ids };
}
