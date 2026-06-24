// src/lib/waitlist/messages.js
//
// Single source of truth for the waitlist SMS copy + merge fields.
//
// These were previously duplicated: the BO editor seed (WaitlistConfig.jsx) used one set
// of {merge-token} wordings, while the runtime fallback (waitlistSlice.sendWaitlistSMS) used
// a DIFFERENT hardcoded set. So a venue that never opened the Tables Ready settings sent copy
// the operator could never see or edit. Both now import these, so "what the editor shows" is
// exactly "what's sent" — before and after the first save.
//
// Supported merge tokens (filled at send time in sendWaitlistSMS):
//   {name}      first name of the party (alias {guest_name})
//   {venue}     the venue display name (locations.name)
//   {size}      party size (alias {party_size})
//   {quote}     quoted wait in minutes (alias {quoted_wait})
//   {position}  1-based place in the live queue by arrival

export const WAITLIST_SMS_DEFAULTS = {
  join: 'Hi {name}, you’re on the list at {venue} — party of {size}. Estimated wait ~{quote} min. We’ll text when your table is ready.',
  next: '{name}, you’re next at {venue}! Please start heading back — your table for {size} is almost ready.',
  ready: '{name}, your table is ready at {venue}! Please see the host. We’ll hold it for a few minutes.',
};

// Chips shown in the BO template editor. All are also honoured by sendWaitlistSMS's fill().
export const WAITLIST_MERGE_FIELDS = ['{name}', '{venue}', '{size}', '{quote}', '{position}'];
