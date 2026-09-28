// src/lib/customerFormAsap.js
//
// WHEN THE CUSTOMER FORM OPENS ON "LATER" (28 Sep 2026). PURE, tested in customerFormAsap.test.js.
//
// CustomerModal started with `existing ? !!existing.isASAP : true`, so an order's customer with NO
// isASAP field at all opened the form on "Later". Customers put on the order by the customer
// display's phone join, or by Link to existing member, carry no such field ({ name, phone,
// stampSummary }). Staff opened the form to add a name, pressed Confirm, and the order was saved as
// a pre-order for the first future slot: Coffee Boy Leeds R9001 and R8674 on 28 Sep, both "11:00".
// The form now opens on "Later" only when the customer really chose a later time: isASAP is
// explicitly false AND there is a collection time. Anything else starts on ASAP.

/** Does the customer form open on ASAP for this order's customer (`existing`, or none)? */
export function formStartsAsap(existing) {
  if (!existing || typeof existing !== 'object') return true;
  return !(existing.isASAP === false && !!existing.collectionTime);
}
