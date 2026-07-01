// src/lib/cardReceipt.js — the CARD SCHEME receipt block (UK).
//
// Visa/Mastercard scheme rules require a card-present receipt to identify the transaction:
// masked PAN (last 4 ONLY — PCI DSS truncation), card scheme, authorisation code, how the card
// was read (entry mode) and how the cardholder was verified (CVM), plus the EMV application id
// (AID) + preferred name for chip/contactless. The merchant identity (name/address/VAT) already
// prints in the receipt HEADER from receipt_branding. This module normalises the card block we
// capture at payment time (Stripe Terminal via stripe-poll-reader-action, Ryft via
// ryft-terminal-poll) and formats it for every render path (ESC/POS, browser print, email).
//
// Pure functions only — unit-tested, no I/O.

const BRAND_LABEL = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express',
  discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay',
  interac: 'Interac', eftpos_au: 'eftpos', unknown: null,
};
const READ_LABEL = {
  contactless_emv: 'Contactless', contactless_magstripe_mode: 'Contactless (MSD)',
  contact_emv: 'Chip', magnetic_stripe_track2: 'Swiped', magnetic_stripe_fallback: 'Swiped (fallback)',
  chip: 'Chip', contactless: 'Contactless', swiped: 'Swiped', manual: 'Keyed',
};
const CVM_LABEL = {
  none: 'No CVM required', offline_pin: 'PIN verified', online_pin: 'PIN verified',
  offline_pin_and_signature: 'PIN + signature', signature: 'Signature', approval: 'Device verified',
};

const titleCase = (s) => String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Normalise the card block off a check, wherever it lives:
 * in-memory record (cardReceipt / paymentIntents[].card) or a closed_checks DB row
 * (card inside payment_intents jsonb). Returns null when the check wasn't a card payment
 * or predates capture — renderers must skip the block entirely then.
 */
export function cardReceiptOf(check) {
  if (!check) return null;
  const direct = check.cardReceipt || check.card_receipt || null;
  if (direct && typeof direct === 'object') return normalise(direct);
  const legs = check.paymentIntents || check.payment_intents;
  if (Array.isArray(legs)) {
    const leg = legs.find((p) => p && p.card && typeof p.card === 'object');
    if (leg) return normalise(leg.card);
  }
  return null;
}

function normalise(c) {
  const brandRaw = c.brand ?? c.scheme ?? null;
  const brandKey = brandRaw ? String(brandRaw).toLowerCase() : null;
  const last4 = c.last4 ?? c.lastFour ?? null;
  const out = {
    // Key-presence check (not ??): BRAND_LABEL maps unknown→null to SUPPRESS the label — `??`
    // would defeat that and print "Unknown" on the receipt.
    brand: brandKey ? (Object.hasOwn(BRAND_LABEL, brandKey) ? BRAND_LABEL[brandKey] : titleCase(brandRaw)) : null,
    last4: last4 ? String(last4).replace(/\D/g, '').slice(-4) || null : null,   // PCI: last 4 ONLY
    authCode: c.auth_code ?? c.authCode ?? null,
    aid: c.aid ?? null,
    applicationName: c.application_name ?? c.applicationName ?? null,
    readMethod: c.read_method ? (READ_LABEL[String(c.read_method).toLowerCase()] ?? titleCase(c.read_method)) : null,
    cvm: c.cvm ? (CVM_LABEL[String(c.cvm).toLowerCase()] ?? titleCase(c.cvm)) : null,
  };
  return (out.brand || out.last4 || out.authCode) ? out : null;
}

/**
 * The block as [label, value] pairs, ready for any renderer (two-column print, html rows,
 * plain-text). Empty array when there's nothing to print.
 */
export function cardReceiptLines(check) {
  const c = cardReceiptOf(check);
  if (!c) return [];
  const lines = [];
  if (c.brand || c.last4) lines.push(['Card', [c.brand, c.last4 ? `**** ${c.last4}` : null].filter(Boolean).join(' ')]);
  if (c.readMethod) lines.push(['Entry', c.readMethod]);
  if (c.cvm) lines.push(['Verification', c.cvm]);
  if (c.authCode) lines.push(['Auth code', c.authCode]);
  if (c.aid) lines.push(['AID', c.aid]);
  if (c.applicationName) lines.push(['App', c.applicationName]);
  return lines;
}

/** One-line plain-text fallback, e.g. "Visa **** 4242 · Contactless · Auth 12345A". */
export function cardReceiptSummary(check) {
  const c = cardReceiptOf(check);
  if (!c) return null;
  return [
    [c.brand, c.last4 ? `**** ${c.last4}` : null].filter(Boolean).join(' ') || null,
    c.readMethod,
    c.authCode ? `Auth ${c.authCode}` : null,
  ].filter(Boolean).join(' · ') || null;
}
