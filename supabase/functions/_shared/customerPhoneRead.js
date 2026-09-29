// supabase/functions/_shared/customerPhoneRead.js
//
// ONE READ OF A CUSTOMER BY PHONE, by the one phone match key (29 Sep 2026, ./phoneKey.js). The
// till (src/lib/customerAutoJoinRun.js) and the edge functions that find a customer by phone
// (loyalty-otp, loyalty-member-lookup, loyalty-balance, gift-fulfill, booking-widget, wifi-capture,
// hubrise-ingest) call this with the Supabase client they already hold, so node tests drive it
// against a fake (src/lib/customerPhoneRead.test.js). No import but the key.
//
// Why one read under several values: customers.phone holds the key for everything written from
// 29 Sep 2026, but older rows hold other shapes of the same number (an import kept a UK landline
// as '01172273489', an older online order stored the digits '447931129015'). phoneLookupValues
// lists the shapes that are provably the same number, exactly the rows the database finds for it
// (20260929a): never a bare 10 digit number read as American, never another number that only
// shares the digits. The row stored as the key wins, then the oldest. Never .maybeSingle(): an
// older build's duplicate made two rows for one number and that read errors on two (the member
// was then not found at all).
//
// `phone` may be the key already (the till passes its own key): the key of a key is the key.

import { phoneMatchKey, phoneLookupValues, pickPhoneRow } from './phoneKey.js';

/**
 * The org's live customer for this number, or null. { data, error } like a Supabase read.
 *   phone   the number (as typed, or already keyed)
 *   typed   the number as typed, when `phone` is the key (its key is looked under too; leave it
 *           out when only `phone` is proven, as the loyalty login's texted number is)
 *   region  the venue's ('GB', 'US' or ''; phoneRegionFromCurrency of its currency)
 *   cols    the columns wanted (id is always there)
 */
export async function readCustomerByPhone(db, { orgId, phone, typed = '', region = '', cols = 'id' }) {
  const values = [];
  for (const v of [...phoneLookupValues(phone, region), ...phoneLookupValues(typed, region)]) {
    if (!values.includes(v)) values.push(v);
  }
  if (!db || !orgId || !values.length) return { data: null, error: null };
  const asked = String(cols ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const whole = asked.includes('*');
  const want = whole ? ['*'] : [...new Set(['id', 'phone', 'created_at', ...asked])];
  const { data, error } = await db.from('customers').select(want.join(', '))
    .eq('org_id', orgId).in('phone', values).is('deleted_at', null)
    .order('created_at', { ascending: true }).limit(10);
  if (error) return { data: null, error };
  const row = pickPhoneRow(data, phoneMatchKey(phone, region));
  if (!row) return { data: null, error: null };
  if (whole) return { data: row, error: null };
  // only the columns asked for (and the id), as the single row read gave them
  const out = {};
  for (const c of new Set(['id', ...asked])) out[c] = row[c] === undefined ? null : row[c];
  return { data: out, error: null };
}
