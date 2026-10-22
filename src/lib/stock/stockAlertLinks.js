// src/lib/stock/stockAlertLinks.js
//
// Multi site stock Drop 3 (map 8.4 step 13): where a stock alert takes the reader. The rules live in
// supabase/functions/_shared/stockNotifyRules.js so stock-notify (the email link and the bell row) and
// the browser (the bell, Needs attention, the Back Office link) read one copy.
export { normFocus, priceRowFocused, parseRefId, boLink, readBoLink, focusText } from '../../../supabase/functions/_shared/stockNotifyRules.js';
