// src/surfaces/bookings/useServiceDay.js
//
// 16 Oct 2026 (bookings audit section 3 item 6): one hook for what a day looks like under the
// venue's service periods, for the Diary and Timeline:
//   startMin, endMin  the minutes the grid draws (the day's services, widened for any booking
//                     outside them so nothing is hidden)
//   bands             closed stretches to grey ([{ startMin, endMin, label }])
//   notice            the words for a closed or blocked day, or null
// With no service periods set: the old single window, no bands, no notice (as before, except a
// booking outside the window now widens the grid instead of being cut off).
// Pure rules in src/lib/bookings/optimiser.js (diaryRange, closedRanges, dayNotice).

import { useMemo } from 'react';
import { diaryRange, closedRanges, dayNotice } from '../../lib/bookings/optimiser.js';

export function useServiceDay(rules, dateISO, bookings = []) {
  const bookingsKey = (bookings || [])
    .filter((b) => b && b.status !== 'cancelled')
    .map((b) => `${String(b.startTime || '').slice(0, 5)}+${b.turnMinutes || 90}`).join(',');
  const rulesKey = JSON.stringify([
    rules?.servicePeriods || [], rules?.closedWeekdays || [], rules?.dateBlocks || [],
    rules?.serviceStart || '', rules?.serviceEnd || '',
  ]);
  return useMemo(() => {
    const live = bookingsKey ? bookingsKey.split(',').map((x) => {
      const [startTime, turn] = x.split('+');
      return { startTime, turnMinutes: Number(turn) || 90 };
    }) : [];
    const { startMin, endMin } = diaryRange(rules || {}, dateISO, { bookings: live });
    return {
      startMin,
      endMin,
      bands: closedRanges(rules || {}, dateISO, startMin, endMin),
      notice: dayNotice(rules || {}, dateISO),
    };
    // rulesKey and bookingsKey stand for rules and bookings (new objects on every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey, dateISO, bookingsKey]);
}
