// supabase/functions/_shared/adyenStorePayload.js
//
// 5.12.57: the body adyen-terminal-admin sends to Adyen to create a venue's store (POST
// /merchants/{m}/stores), built in one pure place so node:test pins it (src/lib/phonesAddressesBatch3.test.js).
//
// A US store: Adyen requires address.stateOrProvince for the US, and the phone goes as E.164 read
// with the US country code ((801) 555-1234 is +18015551234). The old builder sent bare digits
// (8015551234, no +1), no state, and when the address was missing it made one up in London. A US
// venue with no address, state, ZIP code or readable phone is now refused in words: ServOS never
// invents an address.
//
// Every other store (the UK) is built EXACTLY as before, placeholder and all: the same digits
// only phone, the same live refusal, the same test placeholder.
//
// PURE: one import (the region pack), no Deno, so the edge function and node:test read the same rules.

import { toE164 } from './regionPack.js';

/** The 50 states and DC, as Adyen wants them: the two letter code. [code, name]. */
export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
const US_CODES = new Set(US_STATES.map(([c]) => c));

const s = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** "a, b and c" for the refusal sentence. */
function sayList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The store create body, or a refusal in words.
 * @param {object} args
 * @param {Record<string, any>} [args.body]  the action body: { address:{line1,city,postal_code,state_or_province?,country?}, phone, description?, shopper_statement? }
 * @param {string} [args.locName]     the venue's name
 * @param {string} [args.venueCountry='GB']  the venue's country from its Adyen region ('US' | 'GB')
 * @param {boolean} [args.live=false] creating on the LIVE account
 * @returns {{ ok: true, payload: Record<string, unknown> } | { ok: false, error: string }}
 */
export function buildStorePayload({ body = {}, locName = '', venueCountry = 'GB', live = false } = {}) {
  const a = (body && body.address) || {};
  const country = String(a.country || venueCountry);
  const description = String(body.description || locName || 'ServOS venue').slice(0, 100);
  const shopperStatement = String(body.shopper_statement || locName || 'ServOS').replace(/[^a-zA-Z0-9 .,'-]/g, '').slice(0, 22) || 'ServOS';

  if (country.toUpperCase() === 'US') {
    const line1 = s(a.line1), city = s(a.city), zip = s(a.postal_code);
    const state = s(a.state_or_province ?? a.stateOrProvince ?? a.state).toUpperCase();
    const typedPhone = s(body.phone);
    const phone = toE164(typedPhone, '1');
    const missing = [];
    if (!line1) missing.push('street');
    if (!city) missing.push('city');
    if (!state) missing.push('state');
    if (!zip) missing.push('ZIP code');
    if (!typedPhone) missing.push('phone number');
    if (missing.length) {
      return { ok: false, error: `A US store needs the venue's ${sayList(missing)}. ServOS never makes up an address, so nothing was sent to Adyen.` };
    }
    if (!US_CODES.has(state)) return { ok: false, error: `"${state}" is not a US state. Pick the venue's state from the list.` };
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return { ok: false, error: `"${zip}" is not a US ZIP code (five numbers, like 84601).` };
    if (!phone) return { ok: false, error: `"${typedPhone}" does not read as a US phone number. Type it like (801) 555-1234.` };
    return {
      ok: true,
      payload: {
        description, shopperStatement,
        phoneNumber: phone,
        address: { country: 'US', line1, city, stateOrProvince: state, postalCode: zip },
      },
    };
  }

  // Every other country: exactly the body the function built before 5.12.57.
  const phone = String(body.phone || '').replace(/[^\d+]/g, '');
  // The store is the record Adyen keeps for the venue (compliance, receipts, terminal settings).
  // On TEST a placeholder address is fine; on LIVE the real address and phone are required
  // (8 Sep 2026: the panel used to create live stores at "1 High Street, London" with a made up
  // phone number).
  if (live && (!a.line1 || !a.city || !a.postal_code || !phone)) {
    return { ok: false, error: 'A live store needs the venue address (street, town, postcode) and a phone number.' };
  }
  return {
    ok: true,
    payload: {
      description, shopperStatement,
      phoneNumber: phone || '+441234567890',
      address: {
        country,
        line1: String(a.line1 || '1 High Street'),
        city: String(a.city || 'London'),
        postalCode: String(a.postal_code || 'EC1A 1AA'),
      },
    },
  };
}
