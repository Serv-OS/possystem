// src/lib/usCourierWords.js
//
// Decision 9.5 (4 Nov 2026): the delivery courier is Stuart, UK and Europe only. A US venue is
// never offered Stuart setup. Every Back Office screen that would show it says this one line
// instead (the test pins the words). The venue test is activeRegionPack().country === 'US'.

export const US_COURIER_LINE = 'A US courier is not built yet. Delivery orders still work and are driven by your own staff.';
