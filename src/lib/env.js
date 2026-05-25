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
 * e.g. customerUrl('peters-cafe', '/gift/balance')
 *   → https://peters-cafe.serv-os.app/gift/balance       (prod)
 *   → https://peters-cafe.dev.serv-os.app/gift/balance    (dev)
 */
export function customerUrl(slug, path = '') {
  if (!slug) return '';
  return `https://${slug}.${CUSTOMER_ROOT}${path}`;
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
