// src/lib/env.js — Environment configuration
//
// Single source of truth for environment-tier settings.
// Values come from Vite env vars (set per-environment in Vercel):
//
//   VITE_APP_TIER          = 'dev' | 'stage' | 'prod'    (default: 'dev')
//   VITE_CUSTOMER_DOMAIN   = 'serv-os.app'               (default)
//
// Resulting URLs:
//   dev   → dev.serv-os.app (operator), <slug>.dev.serv-os.app (customer)
//   stage → stage.serv-os.app (operator), <slug>.stage.serv-os.app (customer)
//   prod  → app.serv-os.app (operator), <slug>.serv-os.app (customer)

export const APP_TIER = import.meta.env.VITE_APP_TIER || 'dev';
export const CUSTOMER_DOMAIN = import.meta.env.VITE_CUSTOMER_DOMAIN || 'serv-os.app';

/**
 * The root domain for customer-facing subdomains.
 * dev   → dev.serv-os.app   (customer URLs: <slug>.dev.serv-os.app)
 * stage → stage.serv-os.app (customer URLs: <slug>.stage.serv-os.app)
 * prod  → serv-os.app       (customer URLs: <slug>.serv-os.app)
 */
export const CUSTOMER_ROOT = APP_TIER === 'prod'
  ? CUSTOMER_DOMAIN                    // serv-os.app
  : `${APP_TIER}.${CUSTOMER_DOMAIN}`;  // dev.serv-os.app / stage.serv-os.app

/**
 * Build a full customer-facing URL for a given slug and path.
 *
 * The pretty per-venue subdomain (e.g. peters-cafe.serv-os.app/gift/balance) ONLY
 * resolves when the app is actually served from the customer domain. When the app is
 * open on any OTHER host — a raw Vercel preview URL (possystem-*.vercel.app), a
 * not-yet-wired custom domain, or localhost — that subdomain does not exist, so a
 * shared/QR'd link would be dead. In that case we hand out a SAME-ORIGIN link that
 * always works: keep the path and carry the slug in ?loc=. parseCustomerUrl reads the
 * path (and ?loc) identically either way, so every surface routes correctly.
 *
 * e.g. customerUrl('peters-cafe', '/gift/balance')
 *   → https://peters-cafe.serv-os.app/gift/balance                    (served from serv-os.app)
 *   → https://possystem-x.vercel.app/gift/balance?loc=peters-cafe     (served from anywhere else)
 */
export function customerUrl(slug, path = '') {
  if (!slug) return '';
  if (typeof window !== 'undefined') {
    const host = (window.location.hostname || '').toLowerCase();
    const onCustomerDomain = host === CUSTOMER_DOMAIN || host.endsWith(`.${CUSTOMER_DOMAIN}`);
    if (!onCustomerDomain) {
      const p = path || '/';
      const glue = p.includes('?') ? '&' : '?';
      return `${window.location.origin}${p}${glue}loc=${encodeURIComponent(slug)}`;
    }
  }
  return `https://${slug}.${CUSTOMER_ROOT}${path}`;
}

/**
 * Build the multi-site GROUP ordering link — one link a restaurant group puts on
 * their website; customers pick a venue, then order. Path-based (/order/<groupSlug>,
 * groupSlug = platform companies.slug) rather than subdomain-based, so it works on
 * any host that serves this app: the operator domain, a Vercel preview, or a venue
 * subdomain. Same-origin keeps the link alive wherever it was generated.
 */
export function groupOrderUrl(groupSlug) {
  if (!groupSlug) return '';
  const path = `/order/${encodeURIComponent(groupSlug)}`;
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return `https://${OPERATOR_HOST}${path}`;
}

/**
 * Group CATERING link — same idea as groupOrderUrl but for the catering venue
 * picker (/cater/<groupSlug>). Catering is a separate face of the business, so it
 * gets its own link and its own picker (catering-enabled venues only).
 */
export function groupCaterUrl(groupSlug) {
  if (!groupSlug) return '';
  const path = `/cater/${encodeURIComponent(groupSlug)}`;
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return `https://${OPERATOR_HOST}${path}`;
}

/**
 * The operator app hostname.
 * dev → dev.serv-os.app, stage → stage.serv-os.app, prod → app.serv-os.app
 */
export const OPERATOR_HOST = APP_TIER === 'prod'
  ? `app.${CUSTOMER_DOMAIN}`
  : `${APP_TIER}.${CUSTOMER_DOMAIN}`;

/** True if this is the production tier */
export const IS_PROD = APP_TIER === 'prod';

/** Visual label for the tier — shown in status bars, headers, etc. */
export const TIER_LABEL = { dev: 'DEV', stage: 'STAGE', prod: '' }[APP_TIER] || 'DEV';
