// src/staff/staffDates.js
//
// v5.11.101: dates and times in the staff app the venue's way (the snapshot's region locale): en-GB
// for a UK venue, as before; en-US for a US one.

/** "Tue 28 Oct" (UK) or "Tue, Oct 28" (US), from the venue's region. */
export function dayText(iso, locale = 'en-GB') {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** "17:00" (UK) or "5:00 PM" (US). */
export function timeText(hhmm, locale = 'en-GB') {
  if (!hhmm) return '';
  if (!/^en-US$/i.test(locale)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
