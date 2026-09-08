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
import { worstVerificationStatus, LINK_ID_FIELDS } from './adyenLink.js';
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
  const payouts = r?.payouts_ok === true;
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
      payouts: payouts
        ? { tone: 'ok', label: 'Payouts', title: 'Adyen allows payouts to the venue bank account' }
        : { tone: 'missing', label: 'No payouts', title: 'Adyen does not allow payouts to the venue yet' },
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
    if (a.reprovisioned) lines.push({ tone: 'missing', text: `The store and reader setup from ${a.previous || 'the previous environment'} was cleared. Register the card readers again.` });
  }
  if (a.web_origins) lines.push({ tone: 'title', text: 'Web origins', items: registrationLines(a.web_origins) });
  if (a.apple_pay_domains) lines.push({ tone: 'title', text: 'Apple Pay domains', items: registrationLines(a.apple_pay_domains) });
  for (const w of Array.isArray(a.warnings) ? a.warnings : []) lines.push({ tone: 'missing', text: String(w) });
  return lines;
}

// A candidate store as one option label.
export function candidateLabel(c) {
  const x = isObj(c) ? c : {};
  return [x.reference || '(no reference)', x.description ? `"${x.description}"` : '', x.status && x.status !== 'active' ? `(${x.status})` : '', x.id].filter(Boolean).join(' · ');
}
