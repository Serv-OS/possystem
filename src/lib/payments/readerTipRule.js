// readerTipRule.js: when the till tells an Adyen card reader NOT to ask for a tip (30 Sep 2026).
//
// Peter, Coffee Boy Barnsley: "tips are not showing on the card reader" and "the tip should follow
// the rules we set on the card reader side". The till used to suppress the reader's tip prompt on
// every takeaway, collection and drive thru sale, so a coffee shop reader with tips switched on
// almost never asked. Now the reader's own tip settings (Back Office, Card readers, Tips, one per
// reader) decide for every order type. Only a bar tab is still suppressed: it is closed through the
// bar screen's own flow, which is deliberately left as it was.

/** Does the till suppress the card reader's own tip prompt for this sale? */
export function suppressReaderTip(orderType) {
  return orderType === 'bar-tab';
}
