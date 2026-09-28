// src/lib/usePaymentBusy.js (v5.11.x): hold lib/paymentBusy.js while `active` is true and the
// component is mounted, so a release never reloads the page under a payment.
//
// Effects run in the order they are declared: call this ABOVE any effect that starts a card,
// so the hold is taken before the card is. The release is the effect's cleanup, so an unmount
// can never leave the device marked busy.
import { useEffect } from 'react';
import { holdPaymentBusy } from './paymentBusy';

export function usePaymentBusy(active, reason) {
  useEffect(() => (active ? holdPaymentBusy(reason) : undefined), [active, reason]);
}
