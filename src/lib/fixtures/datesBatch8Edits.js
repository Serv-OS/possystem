// src/lib/fixtures/datesBatch8Edits.js
//
// 5.12.57 (US basics batch 8, dates, times and time zones): the one site identity tests prove a one
// site company runs main's screens by putting each screen's listed edits back and hashing the text.
// The batch 8 edits (a day on the site's clock in the site's words) change nothing a UK one site
// company sees: a pound site reads 03/11/2026, as the screen showed on a UK laptop. This table puts
// them back FIRST (siteMoneyEdits.js undoSiteMoney applies it before batch 7 and batch 1): [now, was]
// for each file (from src/), each now found exactly once. Characters outside plain ASCII, and every
// '<', are written as \u escapes, so the table never reads as a JSX tag.

export const DATES_BATCH8_EDITS = Object.freeze({
  "backoffice/sections/purchasing/InvoicesSite.jsx": [
    ["import { dateNumeric } from '../../../lib/venueDates';\n",
      ""],
    ["        const when = (o.receivedAt && dateNumeric(o.receivedAt, cur, venueTz)) || 'recently'; // 5.12.57: the site's day and words, not the laptop's\n",
      "        const when = o.receivedAt ? new Date(o.receivedAt).toLocaleDateString() : 'recently';\n"],
  ],
});
