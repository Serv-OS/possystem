// src/lib/bookings/tillGuestTags.js
//
// Guest tags on the TILL's check header (17 Oct 2026, v5.11.72, PR 295 follow up). Pure, tested
// (tillGuestTags.test.js).
//
// The host stand shows every chip (VIP, Regular, visits, no-shows, the venue's own tags). The till
// is a counter at six live venues with a queue in front of it, so it shows only the two that change
// how a guest is greeted: VIP and Regular. Nothing else, and never more than these two, so the
// header can grow by one short line at most.

export const TILL_CHIP_KEYS = ['vip', 'regular'];

// The host stand's chips (guestChips in supabase/functions/_shared/bookingHost.js), cut to the
// till's, in the same order.
export function tillChips(chips) {
  return (Array.isArray(chips) ? chips : []).filter((c) => c && TILL_CHIP_KEYS.includes(c.key));
}
