// supabase/functions/_shared/leaveBlocks.js (5.12.61, Peter 4 Nov 2026: "be able to say no holiday
// requests in this period")
//
// Blocked periods for time off. A site keeps a list in its Workforce settings
// (wf_venue_settings.settings.leaveBlocks): [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', note }].
// Planned leave (holiday or PTO, unpaid) is refused by the staff app for any day inside a block;
// sick and parental are never blocked. A manager in Back Office sees the block on the request
// form and can still file one (their call). The same rule runs on the server (staff-portal) and
// on both screens. No list = nothing changes.

import { dayText } from './venueDates.js';

/** The leave types a block stops. Sick and parental always go through. */
export const BLOCKED_TYPES = ['holiday', 'unpaid'];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The site's blocks, cleaned: valid days, to on or after from, oldest first. Never throws. */
export function leaveBlocks(settings) {
  const raw = settings && Array.isArray(settings.leaveBlocks) ? settings.leaveBlocks : [];
  return raw
    .map((b) => ({ from: String(b?.from || ''), to: String(b?.to || b?.from || ''), note: String(b?.note || '').trim().slice(0, 120) }))
    .filter((b) => YMD.test(b.from) && YMD.test(b.to) && b.to >= b.from)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** The first block a request of this type touches (any shared day), else null. */
export function blockFor(settings, from, to, type) {
  if (!BLOCKED_TYPES.includes(type)) return null;
  if (!YMD.test(String(from || ''))) return null;
  const end = YMD.test(String(to || '')) ? String(to) : String(from);
  return leaveBlocks(settings).find((b) => b.from <= end && b.to >= String(from)) || null;
}

/**
 * The words a refused request reads: "No holiday requests from 20 Dec 2026 to 3 Jan 2027 (Christmas).
 * Talk to your manager." word = 'holiday' (UK) or 'PTO' (US); venue = currency code or venue facts.
 */
export function blockWords(block, word = 'holiday', venue = 'GBP') {
  if (!block) return '';
  const cur = venue && typeof venue === 'object' ? venue.currency : venue;
  const span = block.from === block.to
    ? `on ${dayText(block.from, { venue: cur })}`
    : `from ${dayText(block.from, { venue: cur })} to ${dayText(block.to, { venue: cur })}`;
  return `No ${word} requests ${span}${block.note ? ` (${block.note})` : ''}. Talk to your manager.`;
}

/** Blocks from today on (past ones are kept in settings but not shown to staff). */
export function upcomingBlocks(settings, todayYmd) {
  const today = YMD.test(String(todayYmd || '')) ? String(todayYmd) : '';
  return leaveBlocks(settings).filter((b) => !today || b.to >= today);
}
