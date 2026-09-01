// src/lib/declineMessage.js
//
// Turn a card refusal into something a member of staff can act on.
//
// Before this, every refusal reached the till as "Card declined, try another
// card". That is wrong advice for most of them: a wrong PIN wants the SAME card
// again, a contactless limit wants the same card INSERTED, and an unreachable
// terminal is not a card problem at all. Adyen sends the real reason on every
// refusal; we were discarding it in favour of a coarse nexo bucket.
//
// Covers Adyen test cases AR001 to AR009, plus NH005, NH006, AC001 and AC003.
//
// Matching is on the lowercased reason text because Adyen's refusal codes are
// not stable across acquirers, whereas the reason strings are documented.

/** @returns {{title:string, advice:string, retrySameCard:boolean}} */
export function declineMessage(reason, errorCondition) {
  const r = String(reason || '').toLowerCase().trim();
  const c = String(errorCondition || '').toLowerCase().trim();

  // Not a card refusal at all. These reached staff as "declined", which sent
  // them hunting for another card while the real fault was the terminal.
  if (c === 'aborted' || r.includes('cancel'))
    return { title: 'Payment cancelled', advice: 'Cancelled on the card machine. Start again when ready.', retrySameCard: true };
  if (c === 'unreachable' || r.includes('unreachable') || r.includes('not reachable'))
    return { title: 'Card machine not reachable', advice: 'Check it is switched on and connected, then try again.', retrySameCard: true };
  if (c === 'timeout' || r.includes('timed out') || r.includes('timeout'))
    return { title: 'Card machine timed out', advice: 'No card was presented in time. Try again.', retrySameCard: true };
  if (c === 'busy' || r.includes('in progress'))
    return { title: 'Card machine is busy', advice: 'Another payment is still running on it. Wait, then try again.', retrySameCard: true };

  // Genuine refusals, in the order Adyen's test plan exercises them.
  if (r.includes('acquirer') && r.includes('cancel'))
    return { title: 'Cancelled by the bank', advice: 'The bank stopped this payment. Try the card again or use another.', retrySameCard: true };
  if (r.includes('fraud') || r.includes('pick up') || r.includes('restricted'))
    return { title: 'Card refused', advice: 'Please ask for another card or another payment method.', retrySameCard: false };
  if (r.includes('not enough balance') || r.includes('insufficient'))
    return { title: 'Not enough money on the card', advice: 'Ask the customer for another card, or take part payment.', retrySameCard: false };
  if (r.includes('acquirer error') || r.includes('issuer unavailable') || r.includes('try again later'))
    return { title: 'Bank could not be reached', advice: 'A temporary problem at the bank. Try the same card again.', retrySameCard: true };
  if (r.includes('pin') && (r.includes('incorrect') || r.includes('invalid') || r.includes('wrong')))
    return { title: 'Wrong PIN', advice: 'Ask the customer to try their PIN again.', retrySameCard: true };
  if (r.includes('pin tries') || r.includes('pin_tries') || r.includes('exceeded') && r.includes('pin'))
    return { title: 'Too many PIN attempts', advice: 'The card is locked. Please ask for another card.', retrySameCard: false };
  // Contactless limits: the fix is to INSERT the same card, not to change card.
  if (r.includes('contactless') || (r.includes('withdrawal') && (r.includes('amount') || r.includes('count'))))
    return { title: 'Contactless limit reached', advice: 'Ask the customer to insert the same card instead of tapping.', retrySameCard: true };
  if (r.includes('not supported') || r.includes('not_supported'))
    return { title: 'Card type not accepted', advice: 'This card type cannot be taken here. Please ask for another.', retrySameCard: false };
  if (r.includes('expired'))
    return { title: 'Card expired', advice: 'Please ask for another card.', retrySameCard: false };
  if (r.includes('referral'))
    return { title: 'Card needs authorisation', advice: 'The bank wants the customer to call them. Ask for another card.', retrySameCard: false };

  // Unknown reason: still show Adyen's own words rather than inventing advice.
  if (reason && r !== 'declined' && r !== 'refused')
    return { title: 'Card declined', advice: String(reason), retrySameCard: false };
  return { title: 'Card declined', advice: 'Please ask for another card.', retrySameCard: false };
}

/** One line for toasts and receipts. */
export function declineLine(reason, errorCondition) {
  const m = declineMessage(reason, errorCondition);
  return `${m.title}. ${m.advice}`;
}
